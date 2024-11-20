import {
  AfterViewInit,
  computed,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  EventEmitter,
  inject,
  Inject,
  Injector,
  input,
  InputSignal,
  model,
  NgZone,
  OnChanges,
  OnInit,
  Output,
  PLATFORM_ID,
  SimpleChanges,
  untracked,
  ViewContainerRef,
} from '@angular/core';
import { isPlatformServer } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Instance } from 'tippy.js';
import { fromEvent, merge, Observable, Subject } from 'rxjs';
import { filter, map, switchMap, takeUntil } from 'rxjs/operators';
import {
  Content,
  isComponent,
  isString,
  isTemplateRef,
  ViewOptions,
  ViewRef,
  ViewService,
} from '@ngneat/overview';

import {
  coerceCssPixelValue,
  dimensionsChanges,
  inView,
  isElementOverflow,
  normalizeClassName,
  observeVisibility,
  onlyTippyProps,
  overflowChanges,
} from './utils';
import {
  TIPPY_CONFIG,
  TIPPY_REF,
  TippyConfig,
  TippyInstance,
  TippyProps,
} from '@ngneat/helipopper/config';
import { TippyFactory } from './tippy.factory';
import { coerceBooleanAttribute } from './coercion';

// These are the default values used by `tippy.js`.
// We are providing them as default input values.
// The `tippy.js` repository has been archived and is unlikely to
// change in the future, so it is safe to use these values as defaults.
const defaultAppendTo: TippyProps['appendTo'] = () => document.body;
const defaultDelay: TippyProps['delay'] = 0;
const defaultDuration: TippyProps['duration'] = [300, 250];
const defaultInteractiveBorder: TippyProps['interactiveBorder'] = 2;
const defaultMaxWidth: TippyProps['maxWidth'] = 350;
const defaultOffset: TippyProps['offset'] = [0, 10];
const defaultPlacement: TippyProps['placement'] = 'top';
const defaultTrigger: TippyProps['trigger'] = 'mouseenter focus';
const defaultTriggerTarget: TippyProps['triggerTarget'] = null;
const defaultZIndex: TippyProps['zIndex'] = 9999;
const defaultAnimation: TippyProps['animation'] = 'fade';

@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: '[tp]',
  exportAs: 'tippy',
  standalone: true,
})
export class TippyDirective implements OnChanges, AfterViewInit, OnInit {
  readonly appendTo = input(defaultAppendTo, {
    alias: 'tpAppendTo',
  });

  readonly content = input<Content | undefined | null>('', { alias: 'tp' });

  readonly delay = input(defaultDelay, {
    alias: 'tpDelay',
  });

  readonly duration = input(defaultDuration, {
    alias: 'tpDuration',
  });

  readonly hideOnClick = input(true, {
    alias: 'tpHideOnClick',
  });

  readonly interactive = input(false, {
    alias: 'tpInteractive',
  });

  readonly interactiveBorder = input(defaultInteractiveBorder, {
    alias: 'tpInteractiveBorder',
  });

  readonly maxWidth = input(defaultMaxWidth, {
    alias: 'tpMaxWidth',
  });

  // Note that some of the input signal types are declared explicitly because the compiler
  // also uses types from `@popperjs/core` and requires a type annotation.
  readonly offset: InputSignal<TippyProps['offset']> = input(defaultOffset, {
    alias: 'tpOffset',
  });

  readonly placement: InputSignal<TippyProps['placement']> = input(defaultPlacement, {
    alias: 'tpPlacement',
  });

  readonly popperOptions: InputSignal<TippyProps['popperOptions']> = input(
    {},
    {
      alias: 'tpPopperOptions',
    }
  );

  readonly showOnCreate = input(false, {
    alias: 'tpShowOnCreate',
  });

  readonly trigger = input(defaultTrigger, {
    alias: 'tpTrigger',
  });

  readonly triggerTarget = input(defaultTriggerTarget, {
    alias: 'tpTriggerTarget',
  });

  readonly zIndex = input(defaultZIndex, {
    alias: 'tpZIndex',
  });

  readonly animation = input(defaultAnimation, {
    alias: 'tpAnimation',
  });

  readonly useTextContent = input(false, {
    transform: coerceBooleanAttribute,
    alias: 'tpUseTextContent',
  });

  readonly isLazy = input(false, {
    transform: coerceBooleanAttribute,
    alias: 'tpIsLazy',
  });

  readonly variation = input<string | undefined>(undefined, { alias: 'tpVariation' });

  readonly isEnabled = input(true, { alias: 'tpIsEnabled' });

  readonly className = input<string | string[]>('', { alias: 'tpClassName' });

  readonly onlyTextOverflow = input(false, {
    transform: coerceBooleanAttribute,
    alias: 'tpOnlyTextOverflow',
  });

  readonly staticWidthHost = input(false, {
    transform: coerceBooleanAttribute,
    alias: 'tpStaticWidthHost',
  });

  readonly data = input<any>(undefined, { alias: 'tpData' });

  readonly useHostWidth = input(false, {
    transform: coerceBooleanAttribute,
    alias: 'tpUseHostWidth',
  });

  readonly hideOnEscape = input(false, {
    transform: coerceBooleanAttribute,
    alias: 'tpHideOnEscape',
  });

  readonly detectChangesComponent = input(true, { alias: 'tpDetectChangesComponent' });

  readonly popperWidth = input<number | string | undefined>(undefined, {
    alias: 'tpPopperWidth',
  });

  readonly customHost = input<HTMLElement | undefined>(undefined, { alias: 'tpHost' });

  readonly isVisible = model(false, { alias: 'tpIsVisible' });

  @Output('tpVisible') visible = new EventEmitter<boolean>();

  protected instance!: TippyInstance;
  protected viewRef: ViewRef | null = null;
  protected props!: Partial<TippyConfig>;
  protected variationDefined = false;
  protected viewOptions$: ViewOptions | null = null;

  /**
   * We had use `visible` event emitter previously as a `takeUntil` subscriber in multiple places
   * within the directive.
   * This is for internal use only; thus we don't have to deal with the `visible` event emitter
   * and trigger change detections only when the `visible` event is being listened outside
   * in the template (`<button [tippy]="..." (visible)="..."></button>`).
   */
  protected visibleInternal = new Subject<boolean>();
  private visibilityObserverCleanup: VoidFunction | null = null;
  private contentChanged = new Subject<void>();

  private host = computed<HTMLElement>(
    () => this.customHost() || this.hostRef.nativeElement
  );

  // It should be a getter because computations are cached until
  // any of the producers change.
  private get hostWidth() {
    return this.host().getBoundingClientRect().width;
  }

  private destroyRef = inject(DestroyRef);
  private isServer = isPlatformServer(inject(PLATFORM_ID));
  private tippyFactory = inject(TippyFactory);

  constructor(
    @Inject(TIPPY_CONFIG) protected globalConfig: TippyConfig,
    protected injector: Injector,
    protected viewService: ViewService,
    protected vcr: ViewContainerRef,
    protected ngZone: NgZone,
    protected hostRef: ElementRef
  ) {
    if (this.isServer) return;

    this.setupListeners();

    this.destroyRef.onDestroy(() => {
      this.instance?.destroy();
      this.destroyView();
      this.visibilityObserverCleanup?.();
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (this.isServer) return;

    const variation = this.variation() || this.globalConfig.defaultVariation || '';
    const props = Object.keys(changes)
      // `isVisible` is not required as a prop since we update it manually
      // in an effect-like manner.
      .filter((key) => key !== 'isVisible')
      .reduce(
        (accumulator, key) => ({ ...accumulator, [key]: changes[key].currentValue }),
        { ...this.globalConfig.variations?.[variation] }
      );

    this.updateProps(props);
  }

  ngOnInit() {
    if (this.useHostWidth()) {
      this.props.maxWidth = this.hostWidth;
    }
  }

  ngAfterViewInit() {
    if (this.isServer) return;

    if (this.isLazy()) {
      const hostInView$ = inView(this.host());

      if (this.onlyTextOverflow()) {
        hostInView$
          .pipe(
            switchMap(() => this.isOverflowing$()),
            takeUntilDestroyed(this.destroyRef)
          )
          .subscribe((isElementOverflow) => {
            this.checkOverflow(isElementOverflow);
          });
      } else {
        hostInView$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
          this.createInstance();
        });
      }
    } else if (this.onlyTextOverflow()) {
      this.isOverflowing$()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((isElementOverflow) => {
          this.checkOverflow(isElementOverflow);
        });
    } else {
      this.createInstance();
    }
  }

  destroyView() {
    this.viewOptions$ = null;
    this.viewRef?.destroy();
    this.viewRef = null;
  }

  /**
   * This method is useful when you append to an element that you might remove from the DOM.
   * In such cases we want to hide the tooltip and let it go through the destroy lifecycle.
   * For example, if you have a grid row with an element that you toggle using the display CSS property on hover.
   */
  observeHostVisibility() {
    if (this.isServer) return;
    // We don't want to observe the host visibility if we are appending to the body.
    if (this.props.appendTo && this.props.appendTo !== document.body) {
      this.visibilityObserverCleanup?.();
      return this.visibleInternal
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((isVisible) => {
          if (isVisible) {
            this.visibilityObserverCleanup = observeVisibility(
              this.instance.reference,
              () => {
                this.hide();
                // Because we have animation on the popper it doesn't close immediately doesn't trigger the `tpVisible` event.
                // Tippy is relying on the transitionend event to trigger the `onHidden` callback.
                // https://github.com/atomiks/tippyjs/blob/master/src/dom-utils.ts#L117
                // This event never fires because the popper is removed from the DOM before the transition ends.
                if (this.props.animation) {
                  this.onHidden();
                }
              }
            );
          } else {
            this.visibilityObserverCleanup?.();
          }
        });
    }
  }

  show() {
    this.instance?.show();
  }

  hide() {
    this.instance?.hide();
  }

  enable() {
    this.instance?.enable();
  }

  disable() {
    this.instance?.disable();
  }

  protected updateProps(props: Partial<TippyConfig>) {
    this.setProps({ ...this.props, ...props });
  }

  protected setProps(props: Partial<TippyConfig>) {
    this.props = props;
    this.instance?.setProps(onlyTippyProps(props));
  }

  protected setStatus(isEnabled: boolean) {
    isEnabled ? this.instance?.enable() : this.instance?.disable();
  }

  protected createInstance() {
    if (!this.content() && !this.useTextContent()) {
      return;
    }

    this.tippyFactory
      .create(this.host(), {
        allowHTML: true,
        appendTo: document.body,
        ...(this.globalConfig.zIndexGetter
          ? { zIndex: this.globalConfig.zIndexGetter() }
          : {}),
        ...onlyTippyProps(this.globalConfig),
        ...onlyTippyProps(this.props),
        onMount: (instance) => {
          const isVisible = true;
          this.isVisible.set(isVisible);
          this.visibleInternal.next(isVisible);
          if (this.visible.observed) {
            this.ngZone.run(() => this.visible.next(isVisible));
          }
          this.useHostWidth() && this.listenToHostResize();
          this.globalConfig.onMount?.(instance);
        },
        onCreate: (instance) => {
          instance.popper.classList.add(
            `tippy-variation-${this.variation() || this.globalConfig.defaultVariation}`
          );
          if (this.className()) {
            for (const klass of normalizeClassName(this.className())) {
              instance.popper.classList.add(klass);
            }
          }
          this.globalConfig.onCreate?.(instance);
          if (this.isVisible() === true) {
            instance.show();
          }
        },
        onShow: (instance) => {
          instance.reference.setAttribute('data-tippy-open', '');

          // We're re-entering because we might create an Angular component,
          // which should be done within the zone.
          const content = this.ngZone.run(() => this.resolveContent(instance));

          if (isString(content)) {
            instance.setProps({ allowHTML: false });

            if (!content?.trim()) {
              this.disable();
            } else {
              this.enable();
            }
          }

          instance.setContent(content);
          this.hideOnEscape() && this.handleEscapeButton();

          if (this.useHostWidth()) {
            this.setInstanceWidth(instance, this.hostWidth);
          } else if (this.popperWidth()) {
            this.setInstanceWidth(instance, this.popperWidth()!);
          }
          this.globalConfig.onShow?.(instance);
        },
        onHide(instance) {
          instance.reference.removeAttribute('data-tippy-open');
        },
        onHidden: (instance) => {
          this.onHidden(instance);
        },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((instance) => {
        this.instance = instance;

        this.setStatus(this.isEnabled());
        this.setProps(this.props);

        this.variation() === 'contextMenu' && this.handleContextMenu();
      });
  }

  protected resolveContent(instance: TippyInstance) {
    const content = this.content();

    if (!this.viewOptions$ && !isString(content)) {
      const injector = Injector.create({
        providers: [
          {
            provide: TIPPY_REF,
            useValue: this.instance,
          },
        ],
        parent: this.injector,
      });

      const data = this.data();

      if (isComponent(content)) {
        this.instance.data = data;

        this.viewOptions$ = {
          injector,
        };
      } else if (isTemplateRef(content)) {
        this.viewOptions$ = {
          injector,
          context: {
            data,
            $implicit: this.hide.bind(this),
          },
        };
      }
    }

    this.viewRef = this.viewService.createView(content!, {
      vcr: this.vcr,
      ...this.viewOptions$,
    });

    // We need to call detectChanges for onPush components to update the content
    if (this.detectChangesComponent() && isComponent(content)) {
      this.viewRef.detectChanges();
    }

    let newContent = this.viewRef.getElement();

    if (this.useTextContent()) {
      newContent = instance.reference.textContent!;
    }

    if (isString(newContent) && this.globalConfig.beforeRender) {
      newContent = this.globalConfig.beforeRender(newContent);
    }

    return newContent;
  }

  protected handleContextMenu() {
    fromEvent<MouseEvent>(this.host(), 'contextmenu')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event: MouseEvent) => {
        event.preventDefault();

        this.instance.setProps({
          getReferenceClientRect: () =>
            ({
              width: 0,
              height: 0,
              top: event.clientY,
              bottom: event.clientY,
              left: event.clientX,
              right: event.clientX,
            } as DOMRectReadOnly),
        });

        this.instance.show();
      });
  }

  protected handleEscapeButton(): void {
    fromEvent<KeyboardEvent>(document.body, 'keydown')
      .pipe(
        filter(({ code }: KeyboardEvent) => code === 'Escape'),
        takeUntil(this.visibleInternal.pipe(filter((v) => !v))),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => this.hide());
  }

  protected checkOverflow(isElementOverflow: boolean) {
    if (isElementOverflow) {
      if (!this.instance) {
        this.createInstance();
      } else {
        this.instance.enable();
      }
    } else {
      this.instance?.disable();
    }
  }

  protected listenToHostResize() {
    dimensionsChanges(this.host())
      .pipe(takeUntil(this.visibleInternal), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.setInstanceWidth(this.instance, this.hostWidth);
      });
  }

  protected setInstanceWidth(instance: Instance, width: string | number) {
    const inPixels = coerceCssPixelValue(width);
    instance.popper.style.width = inPixels;
    instance.popper.style.maxWidth = inPixels;
    (instance.popper.firstElementChild as HTMLElement).style.maxWidth = inPixels;
  }

  private onHidden(instance: TippyInstance = this.instance) {
    this.destroyView();
    const isVisible = false;
    this.isVisible.set(isVisible);
    this.visibleInternal.next(isVisible);
    if (this.visible.observed) {
      this.ngZone.run(() => this.visible.next(isVisible));
    }
    this.globalConfig.onHidden?.(instance);
  }

  private isOverflowing$() {
    const host = this.host();
    const notifiers$ = [overflowChanges(host)];

    // We need to handle cases where the host has a static width but the content might change
    if (this.staticWidthHost()) {
      notifiers$.push(
        this.contentChanged.pipe(
          // We need to wait for the content to be rendered before we can check if it's overflowing.
          switchMap(() => {
            return new Observable((subscriber) => {
              const id = window.requestAnimationFrame(() => {
                subscriber.next();
                subscriber.complete();
              });

              return () => cancelAnimationFrame(id);
            });
          }),
          map(() => isElementOverflow(host))
        )
      );
    }

    return merge(...notifiers$);
  }

  private setupListeners(): void {
    effect(() => {
      // Capture signal read to track its changes.
      this.content();
      untracked(() => this.contentChanged.next());
    });

    effect(() => this.setStatus(this.isEnabled()));

    effect(() => {
      const isVisible = this.isVisible();
      isVisible ? this.show() : this.hide();
    });
  }
}
