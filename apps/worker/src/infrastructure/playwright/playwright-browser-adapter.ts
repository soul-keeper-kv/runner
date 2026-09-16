import type { BrowserContext, CDPSession, Page } from 'playwright';
import type {
  BrowserCookie,
  BrowserPort,
  InspectOptions,
  LocatorMatchInfo,
  NavigateOptions,
  OriginStorageSeed,
  ScreencastFrame,
  ScreencastOptions,
  ScreenshotOptions,
  ScrollOptions,
  ScrollPosition,
} from '@runner/application';
import type {
  ActionResult,
  ElementCandidate,
  ExecutionContext,
  PageSnapshot,
  PageState,
  TestAction,
} from '@runner/domain';
import type { ScopedSelector } from '@runner/selector-model';
import { describeScopedSelector } from '@runner/selector-model';
import { RunnerError, RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';
import { toLocator } from './selector-translator.js';
import { inspectPageScript, type RawSnapshot } from './dom-inspector-script.js';
import { describeAtPointScript, describeElementScript } from './point-pick-script.js';

/**
 * The Playwright implementation of BrowserPort.
 *
 * Everything Playwright-specific in the Runner lives in this directory. The
 * adapter converts between Playwright's imperative, throwing API and the
 * Runner's Result-returning port, which is what allows the pipeline above it to
 * treat "the element was not found" as a value it can record in a timeline
 * rather than an exception that unwinds the run.
 */
export class PlaywrightBrowserAdapter implements BrowserPort {
  /** Set once the page has the transpiler helper shims; see ensureTranspilerHelpers. */
  private helpersInstalled = false;

  /**
   * Every header applied so far.
   *
   * Playwright's `setExtraHTTPHeaders` replaces the whole set, so the adapter
   * accumulates: a profile that sets `Authorization` and then a tenant header
   * must end up with both, and silently losing the first would read as an
   * expired token.
   */
  private readonly extraHeaders: Record<string, string> = {};

  /** The CDP session backing a running screencast, if one is running. */
  private screencast: CDPSession | undefined;

  constructor(
    readonly sessionId: string,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly logger: Logger,
    private readonly defaultTimeoutMs: number,
  ) {}

  async goto(url: string, options: NavigateOptions = {}): Promise<Result<void>> {
    try {
      await this.page.goto(url, {
        waitUntil: options.waitUntil ?? 'domcontentloaded',
        timeout: options.timeoutMs ?? this.defaultTimeoutMs,
      });
      return ok(undefined);
    } catch (cause) {
      return err(
        new RunnerError('PAGE_NOT_REACHABLE', `Could not navigate to ${url}.`, {
          cause,
          details: { url },
          retryable: true,
        }),
      );
    }
  }

  async back(): Promise<Result<void>> {
    return this.navigationStep(() => this.page.goBack({ timeout: this.defaultTimeoutMs }), 'back');
  }

  async forward(): Promise<Result<void>> {
    return this.navigationStep(
      () => this.page.goForward({ timeout: this.defaultTimeoutMs }),
      'forward',
    );
  }

  async reload(): Promise<Result<void>> {
    return this.navigationStep(() => this.page.reload({ timeout: this.defaultTimeoutMs }), 'reload');
  }

  async inspect(options: InspectOptions = {}): Promise<Result<PageSnapshot>> {
    try {
      await this.ensureTranspilerHelpers();

      const raw = (await this.page.evaluate(inspectPageScript, {
        interactableOnly: options.interactableOnly ?? true,
        maxElements: options.maxElements ?? 500,
        ...(options.rootSelector === undefined ? {} : { rootSelector: options.rootSelector }),
      })) as RawSnapshot;

      // A root that matches nothing fails loudly. Returning an empty snapshot
      // would read as "this container is empty", and falling back to the
      // document would hand back the whole page to a caller who asked for one
      // panel — the worse of the two, because nothing in the result says so.
      if (raw.rootMissing === true) {
        return err(
          RunnerErrors.elementNotFound(`inspection root ${options.rootSelector ?? ''}`, {
            rootSelector: options.rootSelector,
            url: raw.url,
          }),
        );
      }

      /*
       * Several matches is also a failure, not a first-match pick.
       *
       * A wildcard root is the normal way to name a panel with a generated id,
       * and a slightly-too-broad one matches its siblings. Scanning the first
       * would produce a registry draft for *a* panel with nothing in the file
       * saying which — the same silent mis-scoping the missing-root check
       * exists to prevent, and harder to notice because the output looks fine.
       */
      if (raw.rootMatchCount !== undefined && raw.rootMatchCount > 1) {
        return err(
          RunnerErrors.elementAmbiguous(
            `inspection root ${options.rootSelector ?? ''}`,
            raw.rootMatchCount,
          ),
        );
      }

      const frames =
        options.includeFrames === true
          ? this.page
              .frames()
              .filter((frame) => frame !== this.page.mainFrame())
              .map((frame, index) => ({
                frameId: `frame_${index}`,
                url: frame.url(),
                ...(frame.name() === '' ? {} : { name: frame.name() }),
              }))
          : [];

      this.logger.debug('Page inspected', {
        sessionId: this.sessionId,
        candidates: raw.elements.length,
        scanned: raw.totalNodesScanned,
      });

      const snapshot: PageSnapshot = {
        url: raw.url,
        ...(raw.title === '' ? {} : { title: raw.title }),
        capturedAt: new Date().toISOString(),
        elements: raw.elements as unknown as ElementCandidate[],
        frames,
        pageMetadata: { totalNodesScanned: raw.totalNodesScanned },
        domFingerprint: raw.domFingerprint,
      };
      return ok(snapshot);
    } catch (cause) {
      return err(RunnerErrors.internal('Page inspection failed.', cause));
    }
  }

  async getCurrentState(): Promise<Result<PageState>> {
    try {
      return ok({
        url: this.page.url(),
        title: await this.page.title(),
        frameCount: this.page.frames().length,
        // Playwright auto-dismisses dialogs unless a handler is attached, so a
        // dialog is never "currently open" from the adapter's point of view.
        hasOpenDialog: false,
        capturedAt: new Date().toISOString(),
      });
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the current page state.', cause));
    }
  }

  async probe(selector: ScopedSelector): Promise<Result<LocatorMatchInfo>> {
    const built = toLocator(this.page, selector);
    if (!built.ok) return built;

    try {
      const locator = built.value;
      const matchCount = await locator.count();

      // A selector matching nothing is a valid answer, not an error: the live
      // workspace shows "0 matches" while the user keeps editing.
      if (matchCount === 0) {
        return ok({ matchCount: 0, visible: false, enabled: false, editable: false });
      }

      const first = locator.first();
      const [visible, enabled, editable, bbox] = await Promise.all([
        first.isVisible().catch(() => false),
        first.isEnabled().catch(() => false),
        first.isEditable().catch(() => false),
        first.boundingBox().catch(() => null),
      ]);

      const info: LocatorMatchInfo = {
        matchCount,
        visible,
        enabled,
        editable,
        ...(bbox === null
          ? {}
          : {
              bbox: {
                x: Math.round(bbox.x),
                y: Math.round(bbox.y),
                width: Math.round(bbox.width),
                height: Math.round(bbox.height),
              },
            }),
      };
      return ok(info);
    } catch (cause) {
      return err(
        RunnerErrors.selectorInvalid(
          describeScopedSelector(selector),
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }
  }

  async execute(
    action: TestAction,
    selector: ScopedSelector | undefined,
    context: ExecutionContext,
  ): Promise<Result<ActionResult>> {
    const startedAt = Date.now();
    const timeout = action.timeoutMs ?? context.plan.options.defaultTimeoutMs;
    const evidence: string[] = [];

    try {
      if (action.type === 'goto') {
        const url = this.resolveUrl(String(action.value ?? ''), context);
        const navigated = await this.goto(url, { timeoutMs: timeout });
        if (!navigated.ok) return navigated;
        evidence.push(`navigated to ${url}`);
        return ok(this.result('PASSED', startedAt, evidence));
      }

      if (action.type === 'wait') {
        await this.page.waitForTimeout(Number(action.value ?? 0));
        evidence.push(`waited ${String(action.value ?? 0)}ms`);
        return ok(this.result('PASSED', startedAt, evidence));
      }

      if (selector === undefined) {
        return err(
          RunnerErrors.actionFailed(action.type, 'No resolved target for an element-bound action.'),
        );
      }

      const built = toLocator(this.page, selector);
      if (!built.ok) return built;
      const locator = built.value;

      evidence.push(`using ${describeScopedSelector(selector)}`);

      switch (action.type) {
        case 'click':
          await locator.click({ timeout });
          break;
        case 'dblclick':
          await locator.dblclick({ timeout });
          break;
        case 'fill':
          await locator.fill(String(action.value ?? ''), { timeout });
          break;
        case 'select':
          await locator.selectOption(String(action.value ?? ''), { timeout });
          break;
        case 'check':
          await locator.check({ timeout });
          break;
        case 'uncheck':
          await locator.uncheck({ timeout });
          break;
        case 'hover':
          await locator.hover({ timeout });
          break;
        case 'press':
          await locator.press(String(action.value ?? ''), { timeout });
          break;
        case 'assert':
          return await this.runAssertion(action, locator, timeout, startedAt, evidence);
        default:
          return err(
            RunnerErrors.actionFailed(action.type, `Action type "${action.type}" is not supported.`),
          );
      }

      evidence.push(`${action.type} succeeded`);
      return ok(this.result('PASSED', startedAt, evidence));
    } catch (cause) {
      return err(
        RunnerErrors.actionFailed(
          action.type,
          cause instanceof Error ? cause.message : String(cause),
          { stepId: action.id },
        ),
      );
    }
  }

  async describeElement(selector: ScopedSelector): Promise<Result<ElementCandidate>> {
    const built = toLocator(this.page, selector);
    if (!built.ok) return built;

    try {
      await this.ensureTranspilerHelpers();

      const locator = built.value.first();
      // Reuses the point-pick script's own resolution so an element described
      // by selector and the same element described by a click agree on their
      // role and accessible name. Reading only the `role` attribute here is
      // what once made this path report role=undefined for a plain <button>.
      const described = await locator.evaluate(describeElementScript);

      const [visible, enabled, editable, bbox] = await Promise.all([
        locator.isVisible().catch(() => false),
        locator.isEnabled().catch(() => false),
        locator.isEditable().catch(() => false),
        locator.boundingBox().catch(() => null),
      ]);

      const candidate: ElementCandidate = {
        runtimeId: `rt_described_${Date.now()}`,
        ...(described.accessibleName === undefined
          ? {}
          : { accessibleName: described.accessibleName }),
        tag: described.tag,
        ...(described.role === undefined ? {} : { role: described.role }),
        ...(described.text === '' ? {} : { text: described.text }),
        attributes: described.attributes,
        visible,
        enabled,
        editable,
        interactable: visible && enabled,
        ...(bbox === null
          ? {}
          : {
              bbox: {
                x: Math.round(bbox.x),
                y: Math.round(bbox.y),
                width: Math.round(bbox.width),
                height: Math.round(bbox.height),
              },
            }),
      };
      return ok(candidate);
    } catch (cause) {
      return err(
        RunnerErrors.elementNotFound(describeScopedSelector(selector), {
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  }

  /**
   * Moves the document and reports where it came to rest.
   *
   * A target is scrolled with Playwright's own `scrollIntoViewIfNeeded` rather
   * than by computing an offset from a bounding box: the box would be measured
   * here and applied a moment later, and anything that reflowed in between —
   * a lazy image resolving, a banner collapsing — moves the element out from
   * under the offset. Asking the engine to bring the element into view keeps
   * the measurement and the movement in the same instant.
   *
   * The offset is always read back from the document afterwards, whichever form
   * was used, because that is the only number a caller can trust: a request to
   * scroll past the end of the page is not an error, it just stops sooner than
   * asked, and a client told "done" with no position cannot tell the difference
   * between that and a page that never moved.
   */
  async scroll(options: ScrollOptions): Promise<Result<ScrollPosition>> {
    try {
      await this.ensureTranspilerHelpers();

      if (options.target !== undefined) {
        const built = toLocator(this.page, options.target);
        if (!built.ok) return built;

        const first = built.value.first();
        if ((await first.count()) === 0) {
          return err(
            RunnerErrors.elementNotFound(describeScopedSelector(options.target), {
              reason: 'nothing on the page matches the element to scroll to',
            }),
          );
        }

        await first.scrollIntoViewIfNeeded();

        // `scrollIntoViewIfNeeded` does nothing when the element is already
        // within the viewport, which is correct for reaching it and wrong for
        // *reading* it: a user asking to centre something expects it centred
        // even when it is barely on screen. Only an explicit block asks for
        // that, so the default stays as the engine's cheaper behaviour.
        if (options.block !== undefined && options.block !== 'nearest') {
          await first.evaluate(
            (element: Element, block: 'start' | 'center' | 'end') => {
              element.scrollIntoView({ block, inline: 'nearest', behavior: 'auto' });
            },
            options.block,
          );
        }
      } else {
        await this.page.evaluate(
          (input: {
            by?: { x?: number; y?: number };
            to?: { x?: number; y?: number } | 'top' | 'bottom';
            behavior?: 'auto' | 'smooth';
          }) => {
            const behavior = input.behavior ?? 'auto';

            if (input.to === 'top') {
              window.scrollTo({ left: 0, top: 0, behavior });
              return;
            }

            if (input.to === 'bottom') {
              // The document's own height, read in the page: a client cannot
              // know it, and a large sentinel number would scroll to the end
              // of *this* page while overshooting on any other.
              window.scrollTo({
                left: window.scrollX,
                top: document.documentElement.scrollHeight,
                behavior,
              });
              return;
            }

            if (input.to !== undefined) {
              window.scrollTo({
                left: input.to.x ?? window.scrollX,
                top: input.to.y ?? window.scrollY,
                behavior,
              });
              return;
            }

            window.scrollBy({
              left: input.by?.x ?? 0,
              top: input.by?.y ?? 0,
              behavior,
            });
          },
          {
            ...(options.by === undefined ? {} : { by: options.by }),
            ...(options.to === undefined ? {} : { to: options.to }),
            ...(options.behavior === undefined ? {} : { behavior: options.behavior }),
          },
        );
      }

      const position = await this.page.evaluate(() => {
        const doc = document.documentElement;
        return {
          x: Math.round(window.scrollX),
          y: Math.round(window.scrollY),
          maxX: Math.max(0, Math.round(doc.scrollWidth - window.innerWidth)),
          maxY: Math.max(0, Math.round(doc.scrollHeight - window.innerHeight)),
        };
      });

      return ok(position);
    } catch (cause) {
      return err(RunnerErrors.internal('Scroll failed.', cause));
    }
  }

  /**
   * Reads back whichever element sits at a viewport point.
   *
   * `elementFromPoint` returns the *topmost* element, which is what a user
   * clicking the frame means — an overlay or a label sitting above a control is
   * genuinely what they pointed at. It then walks up to the nearest interactive
   * ancestor, because clicking the text inside a button means the button.
   */
  async describeElementAtPoint(x: number, y: number): Promise<Result<ElementCandidate>> {
    try {
      // Required at every evaluate site: esbuild rewrites functions as
      // `__name(fn, "…")` and that helper does not exist in the page.
      await this.ensureTranspilerHelpers();

      const described = await this.page.evaluate(describeAtPointScript, { x, y });

      if (described === null) {
        return err(
          RunnerErrors.elementNotFound(`point (${x}, ${y})`, {
            reason: 'no element sits at that point in the viewport',
            x,
            y,
          }),
        );
      }

      const candidate: ElementCandidate = {
        runtimeId: `rt_${described.domIndex}`,
        tag: described.tag,
        ...(described.role === undefined ? {} : { role: described.role }),
        // The script resolves this through label[for], a wrapping label,
        // aria-label and so on. Dropping it here is what once made a picked
        // email field report its placeholder instead of its label.
        ...(described.accessibleName === undefined
          ? {}
          : { accessibleName: described.accessibleName }),
        ...(described.text === undefined || described.text === ''
          ? {}
          : { text: described.text }),
        attributes: described.attributes,
        visible: described.visible,
        enabled: described.enabled,
        editable: described.editable,
        interactable: described.visible && described.enabled,
        bbox: described.bbox,
        domIndex: described.domIndex,
      };

      return ok(candidate);
    } catch (cause) {
      return err(
        RunnerErrors.internal(
          `Could not describe the element at (${x}, ${y}).`,
          cause,
        ),
      );
    }
  }

  /**
   * Serializes the context's cookies and origin storage.
   *
   * Read from the BrowserContext rather than the page: a login may set cookies
   * on a different origin than the one currently shown, and the context is what
   * a later launch is restored from.
   */
  async captureStorageState(): Promise<Result<unknown>> {
    try {
      return ok(await this.context.storageState());
    } catch (cause) {
      return err(RunnerErrors.internal('Could not capture the browser storage state.', cause));
    }
  }

  /**
   * Adds headers to every subsequent request from this context.
   *
   * Playwright replaces the whole set on each call, so the adapter accumulates
   * them: a profile that sets `Authorization` and then a tenant header must end
   * up with both, and losing the first would look like an expired token.
   */
  async setExtraHeaders(headers: Readonly<Record<string, string>>): Promise<Result<void>> {
    try {
      Object.assign(this.extraHeaders, headers);
      await this.context.setExtraHTTPHeaders({ ...this.extraHeaders });

      // Names only. A header value is frequently the credential itself.
      this.logger.debug('Extra request headers applied', {
        headers: Object.keys(this.extraHeaders),
      });
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not apply request headers.', cause));
    }
  }

  async addCookies(cookies: readonly BrowserCookie[]): Promise<Result<void>> {
    if (cookies.length === 0) return ok(undefined);

    try {
      await this.context.addCookies(
        cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          ...(cookie.url === undefined ? {} : { url: cookie.url }),
          ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
          ...(cookie.path === undefined ? { path: '/' } : { path: cookie.path }),
          ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
          ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
          ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
          ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
        })),
      );

      this.logger.debug('Cookies seeded', { cookies: cookies.map((cookie) => cookie.name) });
      return ok(undefined);
    } catch (cause) {
      return err(
        RunnerErrors.internal(
          // Playwright rejects a cookie with neither url nor domain, and the
          // message is otherwise cryptic.
          'Could not seed cookies. Each one needs a url or a domain.',
          cause,
        ),
      );
    }
  }

  /**
   * Writes storage for an origin.
   *
   * Storage only exists once a document from that origin has loaded, so this
   * navigates there first. `addInitScript` then writes the entries *before* any
   * application script runs on the next load — which is the whole point: an app
   * reads its token during bootstrap, so writing afterwards is too late and
   * looks exactly like a token that does not work.
   */
  async seedOriginStorage(input: OriginStorageSeed): Promise<Result<void>> {
    try {
      await this.page.goto(input.origin, {
        waitUntil: 'domcontentloaded',
        timeout: this.defaultTimeoutMs,
      });

      // Both calls below send a function into the page, so the esbuild `__name`
      // shim has to exist there first. Without this the whole thing works from
      // dist/ and dies from source with `__name is not defined`.
      await this.ensureTranspilerHelpers();

      const payload = { storage: input.storage, entries: input.entries };

      // Applied to every later navigation in this context, so a page reload —
      // or the app redirecting to /login and back — keeps the token.
      await this.context.addInitScript(
        ({ storage, entries }: { storage: string; entries: Record<string, string> }) => {
          const target = storage === 'sessionStorage' ? window.sessionStorage : window.localStorage;
          for (const [key, value] of Object.entries(entries)) {
            try {
              target.setItem(key, value);
            } catch {
              // A blocked or full storage must not abort the run; the login
              // will fail visibly on the next assertion instead.
            }
          }
        },
        payload,
      );

      // And once now, for the document already open.
      await this.page.evaluate(
        ({ storage, entries }: { storage: string; entries: Record<string, string> }) => {
          const target = storage === 'sessionStorage' ? window.sessionStorage : window.localStorage;
          for (const [key, value] of Object.entries(entries)) {
            try {
              target.setItem(key, value);
            } catch {
              /* as above */
            }
          }
        },
        payload,
      );

      this.logger.debug('Origin storage seeded', {
        origin: input.origin,
        storage: input.storage,
        // Keys only: the value is the token.
        keys: Object.keys(input.entries),
      });
      return ok(undefined);
    } catch (cause) {
      return err(
        RunnerErrors.internal(`Could not seed ${input.storage} for ${input.origin}.`, cause),
      );
    }
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Result<Buffer>> {
    try {
      const buffer = await this.page.screenshot({
        fullPage: options.fullPage ?? false,
        type: options.format ?? 'png',
        ...(options.format === 'jpeg' && options.quality !== undefined
          ? { quality: options.quality }
          : {}),
      });
      return ok(buffer);
    } catch (cause) {
      return err(RunnerErrors.internal('Screenshot failed.', cause));
    }
  }

  /**
   * Streams the viewport with Chrome DevTools screencast.
   *
   * Measured against a screenshot-per-request loop on the same page: ~60 frames
   * a second with a first frame in ~10ms, versus ~30 screenshots a second
   * before any of them has been base64'd or put on a socket. The difference is
   * not the encode — it is that the engine emits on repaint instead of being
   * asked.
   *
   * Every frame is acknowledged before the next is requested. That ack *is* the
   * backpressure: without it Chrome keeps producing frames for a consumer that
   * has stopped reading, and the queue grows until something falls over.
   */
  async startScreencast(
    onFrame: (frame: ScreencastFrame) => void,
    options: ScreencastOptions = {},
  ): Promise<Result<void>> {
    if (this.screencast !== undefined) {
      // Idempotent rather than an error: two clients watching one session is a
      // normal thing to ask for, and the second must not tear down the first.
      return ok(undefined);
    }

    const format = options.format ?? 'jpeg';

    try {
      const cdp = await this.context.newCDPSession(this.page);
      this.screencast = cdp;

      cdp.on('Page.screencastFrame', (event) => {
        // Acknowledged first, and regardless of what the consumer does with
        // it: a throwing handler must not stall the stream.
        void cdp
          .send('Page.screencastFrameAck', { sessionId: event.sessionId })
          .catch(() => undefined);

        try {
          onFrame({
            format,
            data: event.data,
            // The engine reports the frame's own size, which can differ from
            // the viewport while a page is resizing. Reporting what was
            // actually captured keeps overlay boxes aligned with it.
            width: event.metadata.deviceWidth ?? this.page.viewportSize()?.width ?? 0,
            height: event.metadata.deviceHeight ?? this.page.viewportSize()?.height ?? 0,
            capturedAt: new Date().toISOString(),
            /*
             * Forwarded so an overlay can survive a scroll it did not cause.
             *
             * Boxes are measured in viewport coordinates by an inspection that
             * happened at some earlier offset. Once the page moves — a wheel, a
             * focused input scrolling itself into view, an anchor jump — those
             * boxes describe a viewport this frame no longer shows. The offset
             * travels with the picture it belongs to, which is the only pairing
             * that is certain to agree, so a client can shift the overlay by
             * the difference instead of paying for a fresh scan.
             *
             * `scrollOffsetX/Y` is what the engine reports; the document's
             * limits are not part of a frame and are read by `scroll` instead.
             */
            ...(event.metadata.scrollOffsetX === undefined ||
            event.metadata.scrollOffsetY === undefined
              ? {}
              : {
                  scrollOffset: {
                    x: Math.round(event.metadata.scrollOffsetX),
                    y: Math.round(event.metadata.scrollOffsetY),
                    maxX: 0,
                    maxY: 0,
                  },
                }),
          });
        } catch (cause) {
          this.logger.debug('Screencast frame consumer failed', {
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });

      await cdp.send('Page.enable');
      await cdp.send('Page.startScreencast', {
        format,
        ...(options.quality === undefined ? { quality: 60 } : { quality: options.quality }),
        everyNthFrame: options.everyNthFrame ?? 1,
      });

      this.logger.debug('Screencast started', { format });
      return ok(undefined);
    } catch (cause) {
      this.screencast = undefined;
      return err(RunnerErrors.internal('Could not start a screencast.', cause));
    }
  }

  async stopScreencast(): Promise<Result<void>> {
    const cdp = this.screencast;
    if (cdp === undefined) return ok(undefined);
    this.screencast = undefined;

    try {
      await cdp.send('Page.stopScreencast');
      await cdp.detach().catch(() => undefined);
      this.logger.debug('Screencast stopped');
      return ok(undefined);
    } catch (cause) {
      // A stream that cannot be stopped cleanly is still stopped as far as the
      // caller is concerned: the session is detached and the page keeps working.
      this.logger.debug('Screencast stop failed', {
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return ok(undefined);
    }
  }

  /**
   * Draws a transient outline around a match.
   *
   * Used only by the live workspace for visual feedback; it never participates
   * in resolution, so a page that blocks the injected style is not a failure.
   */
  async highlight(selector: ScopedSelector, durationMs = 1500): Promise<Result<void>> {
    const built = toLocator(this.page, selector);
    if (!built.ok) return built;

    try {
      await this.ensureTranspilerHelpers();

      await built.value.first().evaluate((element: Element, ms: number) => {
        const target = element as HTMLElement;
        const previousOutline = target.style.outline;
        const previousOffset = target.style.outlineOffset;
        target.style.outline = '3px solid #2563eb';
        target.style.outlineOffset = '2px';
        window.setTimeout(() => {
          target.style.outline = previousOutline;
          target.style.outlineOffset = previousOffset;
        }, ms);
      }, durationMs);
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Highlight failed.', cause));
    }
  }

  async close(): Promise<void> {
    try {
      await this.context.close();
    } catch (cause) {
      this.logger.warn('Browser context close failed', {
        sessionId: this.sessionId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // ---- internals ----

  /**
   * Defines the helpers a transpiler may have baked into a serialized function.
   *
   * `page.evaluate` serializes a function's *compiled* source and runs it in
   * the page. esbuild — which tsx uses, so this hits `pnpm dev` and any
   * launch config that runs TypeScript directly — wraps named functions and
   * arrows in a `__name(fn, "name")` helper to preserve `Function.name`. That
   * helper is defined in the Node module scope, not in the page, so the
   * serialized function throws `ReferenceError: __name is not defined` the
   * moment it runs. Compiled `dist/` output has no such wrapper, which is why
   * this only appears when running from source.
   *
   * Rather than fight the transpiler, the page is given a matching definition.
   * It is installed via `addInitScript` so it survives navigation, and is
   * idempotent so repeated inspections cost nothing.
   */
  private async ensureTranspilerHelpers(): Promise<void> {
    if (this.helpersInstalled) return;

    const defineHelpers = (): void => {
      const scope = globalThis as unknown as Record<string, unknown>;
      if (typeof scope.__name !== 'function') {
        scope.__name = (target: unknown) => target;
      }
    };

    // Run it now for the current document, and on every future navigation.
    await this.page.addInitScript(defineHelpers);
    await this.page.evaluate(defineHelpers);
    this.helpersInstalled = true;
  }

  private async runAssertion(
    action: TestAction,
    locator: ReturnType<typeof toLocator> extends Result<infer L> ? L : never,
    timeout: number,
    startedAt: number,
    evidence: string[],
  ): Promise<Result<ActionResult>> {
    const assertion = action.assertion;
    if (assertion === undefined) {
      return err(RunnerErrors.assertionFailed('Assert step carried no assertion.'));
    }

    const expected = assertion.expected;
    const effectiveTimeout = assertion.timeoutMs ?? timeout;

    switch (assertion.type) {
      case 'visible': {
        const visible = await locator
          .first()
          .waitFor({ state: 'visible', timeout: effectiveTimeout })
          .then(() => true)
          .catch(() => false);
        return this.assertThat(visible, 'element is visible', startedAt, evidence);
      }
      case 'hidden': {
        const hidden = await locator
          .first()
          .waitFor({ state: 'hidden', timeout: effectiveTimeout })
          .then(() => true)
          .catch(() => false);
        return this.assertThat(hidden, 'element is hidden', startedAt, evidence);
      }
      case 'text': {
        const actual = (await locator.first().textContent())?.trim() ?? '';
        return this.assertThat(
          actual === String(expected),
          `text is "${String(expected)}" (actual "${actual}")`,
          startedAt,
          evidence,
        );
      }
      case 'containsText': {
        const actual = (await locator.first().textContent())?.trim() ?? '';
        return this.assertThat(
          actual.includes(String(expected)),
          `text contains "${String(expected)}" (actual "${actual}")`,
          startedAt,
          evidence,
        );
      }
      case 'value': {
        const actual = await locator.first().inputValue();
        return this.assertThat(
          actual === String(expected),
          `value is "${String(expected)}" (actual "${actual}")`,
          startedAt,
          evidence,
        );
      }
      case 'enabled':
        return this.assertThat(
          await locator.first().isEnabled(),
          'element is enabled',
          startedAt,
          evidence,
        );
      case 'disabled':
        return this.assertThat(
          await locator.first().isDisabled(),
          'element is disabled',
          startedAt,
          evidence,
        );
      case 'checked':
        return this.assertThat(
          await locator.first().isChecked(),
          'element is checked',
          startedAt,
          evidence,
        );
      case 'count': {
        const actual = await locator.count();
        return this.assertThat(
          actual === Number(expected),
          `match count is ${String(expected)} (actual ${actual})`,
          startedAt,
          evidence,
        );
      }
      case 'urlMatches': {
        const actual = this.page.url();
        return this.assertThat(
          new RegExp(String(expected)).test(actual),
          `url matches ${String(expected)} (actual ${actual})`,
          startedAt,
          evidence,
        );
      }
      default:
        return err(
          RunnerErrors.assertionFailed(`Assertion type "${assertion.type}" is not supported.`),
        );
    }
  }

  private assertThat(
    passed: boolean,
    description: string,
    startedAt: number,
    evidence: string[],
  ): Result<ActionResult> {
    if (passed) {
      evidence.push(`assertion passed: ${description}`);
      return ok(this.result('PASSED', startedAt, evidence));
    }
    return err(RunnerErrors.assertionFailed(`Assertion failed: ${description}`));
  }

  private async navigationStep(
    step: () => Promise<unknown>,
    label: string,
  ): Promise<Result<void>> {
    try {
      await step();
      return ok(undefined);
    } catch (cause) {
      return err(
        new RunnerError('PAGE_NOT_REACHABLE', `Navigation "${label}" failed.`, { cause }),
      );
    }
  }

  /** Resolves a relative path against the plan's base URL, if one is set. */
  private resolveUrl(value: string, context: ExecutionContext): string {
    const baseUrl = context.plan.options.baseUrl;
    if (baseUrl === undefined || /^https?:\/\//i.test(value)) return value;
    return new URL(value, baseUrl).toString();
  }

  private result(
    status: ActionResult['status'],
    startedAt: number,
    evidence: readonly string[],
  ): ActionResult {
    return {
      status,
      durationMs: Date.now() - startedAt,
      evidence: [...evidence],
      artifactIds: [],
    };
  }
}
