import type {
  ActionResult,
  ElementCandidate,
  ExecutionContext,
  PageSnapshot,
  PageState,
  TestAction,
} from '@runner/domain';
import type { ScopedSelector, SelectorDefinition } from '@runner/selector-model';
import type { Result } from '@runner/shared';

/**
 * The only way any Runner code reaches a browser (blueprint sections 3.1, 8).
 *
 * Nothing in this file mentions Playwright. That is the point: the same
 * interface is what a Selenium or Appium driver would implement, and it is why
 * the live workspace can drive a browser without ever knowing which engine is
 * behind it.
 */

export interface LocatorMatchInfo {
  readonly matchCount: number;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly bbox?: { x: number; y: number; width: number; height: number };
  readonly role?: string;
  readonly accessibleName?: string;
  readonly textContent?: string;
}

export interface NavigateOptions {
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  readonly timeoutMs?: number;
}

export interface InspectOptions {
  /** Skip elements no user could interact with. */
  readonly interactableOnly?: boolean;
  readonly includeFrames?: boolean;
  readonly maxElements?: number;
  /**
   * Inspect only inside this container, given as a raw CSS selector.
   *
   * The one place in the Runner where a caller supplies a CSS selector, and it
   * is deliberate: this names *where to look*, not which element to act on, so
   * it never becomes a target and never reaches the Registry. Blueprint rule 4
   * still holds for everything downstream — the selectors this returns are
   * generated structured data, as before.
   *
   * Scoping here rather than filtering afterwards is what makes it worth
   * having: `maxElements` then applies within the container, so a panel on a
   * long page cannot lose its elements to a cap spent on the page around it.
   *
   * A selector matching nothing is an error, never a silent fall back to the
   * whole document: a caller that believes it scoped the scan would otherwise
   * receive the entire page and have no way to tell.
   */
  readonly rootSelector?: string;
}

export interface ScreenshotOptions {
  readonly fullPage?: boolean;
  readonly format?: 'png' | 'jpeg';
  readonly quality?: number;
}

export interface ScreencastOptions {
  /**
   * JPEG by default, and deliberately: a stream's frames are mostly
   * photographic deltas of the same page, where JPEG is both smaller and
   * faster to encode. PNG remains right for a single still of flat UI.
   */
  readonly format?: 'png' | 'jpeg';
  readonly quality?: number;
  /**
   * Emit only every Nth frame the engine produces.
   *
   * The engine can repaint at 60fps; nothing downstream benefits from that, and
   * every frame costs an encode plus a socket message. Thinning at the source
   * is cheaper than dropping frames after they have been paid for.
   */
  readonly everyNthFrame?: number;
}

export interface ScreencastFrame {
  readonly format: 'png' | 'jpeg';
  /** Base64-encoded image data, ready to put in a data URL. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
  /**
   * Where the document sat when this frame was painted.
   *
   * Carried because a frame and the boxes drawn over it are produced at
   * different moments. Boxes come from an inspection in viewport coordinates;
   * once the page scrolls, that inspection describes a viewport the frame no
   * longer shows, and every highlight is off by the difference. A client that
   * knows both offsets can subtract them and keep the overlay aligned without
   * re-scanning the page — which is the expensive half.
   *
   * The engine reports it per frame, so it costs nothing to forward and is the
   * only self-consistent pairing of picture and offset available.
   */
  readonly scrollOffset?: ScrollPosition;
}

/**
 * A document scroll offset, in CSS pixels from the top-left of the page.
 *
 * `maxX`/`maxY` are the furthest the document can scroll — `scrollWidth` minus
 * the viewport. Reported because "am I already at the bottom?" is otherwise
 * unanswerable from outside the page, and a client that cannot tell will keep
 * sending wheel commands that do nothing.
 */
export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** How a caller asks the page to move. Exactly one of these is honoured. */
export interface ScrollOptions {
  /** A relative nudge, in CSS pixels. */
  readonly by?: { readonly x?: number; readonly y?: number };
  /** An absolute offset, or an end of the document. */
  readonly to?: { readonly x?: number; readonly y?: number } | 'top' | 'bottom';
  /**
   * Scrolls until this element is in view.
   *
   * A selector, not an offset: the page resolves where the element is at the
   * moment it scrolls, so a caller holding a bbox measured before the last
   * repaint cannot scroll to a position the element has since left.
   */
  readonly target?: ScopedSelector;
  readonly block?: 'start' | 'center' | 'end' | 'nearest';
  readonly behavior?: 'auto' | 'smooth';
}

/**
 * One browser context, already authenticated where a profile applies.
 * Obtained from BrowserManagerPort; never constructed directly.
 */
export interface BrowserPort {
  readonly sessionId: string;

  goto(url: string, options?: NavigateOptions): Promise<Result<void>>;
  back(): Promise<Result<void>>;
  forward(): Promise<Result<void>>;
  reload(): Promise<Result<void>>;

  /** Builds the structured page model. Never returns raw HTML. */
  inspect(options?: InspectOptions): Promise<Result<PageSnapshot>>;
  getCurrentState(): Promise<Result<PageState>>;

  /** Evaluates a selector without acting on it — the basis of live preview. */
  probe(selector: ScopedSelector): Promise<Result<LocatorMatchInfo>>;

  /**
   * Moves the document, and reports where it ended up.
   *
   * Separate from `execute` even though a step can scroll, because these are
   * different things: a test step scrolls as part of what it asserts, while
   * this serves a human looking at a live page. Folding them together would
   * put a user's idle wheel movements into an execution timeline.
   *
   * Returning the new position rather than nothing is what makes a wheel usable
   * from outside the page: only the document knows whether it actually moved,
   * and a client with no answer either re-reads the page or keeps sending
   * commands into a document already at its end.
   */
  scroll(options: ScrollOptions): Promise<Result<ScrollPosition>>;

  execute(
    action: TestAction,
    selector: ScopedSelector | undefined,
    context: ExecutionContext,
  ): Promise<Result<ActionResult>>;

  /** Reads one element back as a candidate, e.g. after a user picks it. */
  describeElement(selector: ScopedSelector): Promise<Result<ElementCandidate>>;

  /**
   * Reads back whichever element sits at a viewport point.
   *
   * This is what makes element picking possible: the live workspace renders a
   * frame, the user clicks it, and the point maps onto the page directly. The
   * alternative — asking the client to turn a click into a selector — would put
   * selector construction in a browser tab, which is exactly what the Runner
   * keeps on the worker side of the port.
   *
   * Coordinates are in the viewport space that `probe` and screenshots report,
   * so a client never has to convert between spaces.
   */
  describeElementAtPoint(x: number, y: number): Promise<Result<ElementCandidate>>;

  /**
   * Serializes the context's cookies and origin storage.
   *
   * This is the other half of `BrowserLaunchOptions.storageState`: a form login
   * is replayed once, its result captured here, and every later run starts
   * already authenticated. Without a way to read the state back out, a stored
   * profile could only ever be written by hand.
   *
   * Deliberately `unknown` — the shape belongs to the engine, and the
   * application layer only ever stores it and hands it back.
   */
  captureStorageState(): Promise<Result<unknown>>;

  /**
   * Adds headers to every subsequent request this context makes.
   *
   * Applied to a context that is *already open*, which is what lets a live
   * session authenticate without restarting — the page keeps the state that
   * made it worth investigating.
   *
   * Note what this cannot do: browsers send context headers to every origin the
   * page reaches, including third parties. A caller putting a credential here
   * is trusting every host the application talks to, so `AuthService` warns
   * when a profile does it.
   */
  setExtraHeaders(headers: Readonly<Record<string, string>>): Promise<Result<void>>;

  /** Seeds cookies, e.g. a session token an API login returned. */
  addCookies(cookies: readonly BrowserCookie[]): Promise<Result<void>>;

  /**
   * Writes `localStorage` or `sessionStorage` for an origin.
   *
   * Storage is origin-scoped and only exists once a document from that origin
   * has loaded, so an implementation has to visit the origin first. That makes
   * this a navigation — the caller gets the page it asked for afterwards, not
   * whatever was open before.
   */
  seedOriginStorage(input: OriginStorageSeed): Promise<Result<void>>;

  screenshot(options?: ScreenshotOptions): Promise<Result<Buffer>>;

  /**
   * Streams the viewport as frames until stopped.
   *
   * The live view's other half. A screenshot per request tops out at a few
   * frames a second once each one has crossed a socket, and between requests
   * the picture is silently out of date — so a preview built on it reads as
   * frozen rather than live. A stream pushes instead: the engine emits a frame
   * when the page actually repaints.
   *
   * Behind a port because the engine's mechanism is not the application's
   * business: this is Chrome DevTools screencast today and could be WebRTC
   * later without anything above the port knowing. That is the seam the state
   * capability's comment has been anticipating.
   *
   * `onFrame` is called with an already-encoded image. Implementations are
   * expected to acknowledge each frame to the engine before requesting the
   * next, so a slow consumer slows the stream rather than queueing frames
   * without limit.
   */
  startScreencast(
    onFrame: (frame: ScreencastFrame) => void,
    options?: ScreencastOptions,
  ): Promise<Result<void>>;

  /** Stops a stream started by `startScreencast`. Safe to call when idle. */
  stopScreencast(): Promise<Result<void>>;

  /** Draws a transient overlay for the live workspace. */
  highlight(selector: ScopedSelector, durationMs?: number): Promise<Result<void>>;

  close(): Promise<void>;
}

/** A cookie as the Runner describes one, independent of any engine. */
export interface BrowserCookie {
  readonly name: string;
  readonly value: string;
  /** One of these is required; a cookie with neither belongs nowhere. */
  readonly domain?: string;
  readonly url?: string;
  readonly path?: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  /** Unix seconds. Absent means a session cookie. */
  readonly expires?: number;
}

export interface OriginStorageSeed {
  /** Scheme and host, e.g. `https://app.example.com`. */
  readonly origin: string;
  readonly storage: 'localStorage' | 'sessionStorage';
  readonly entries: Readonly<Record<string, string>>;
}

export interface BrowserLaunchOptions {
  readonly headless: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly baseUrl?: string;
  /** Serialized cookies/localStorage restoring an authenticated session. */
  readonly storageState?: unknown;
  readonly defaultTimeoutMs?: number;
  /**
   * Headers sent with every request from this context.
   *
   * Set at launch when the profile is known up front, which is the common case
   * for an execution. A live session that authenticates later uses
   * `BrowserPort.setExtraHeaders` instead, because it must not restart.
   */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly cookies?: readonly BrowserCookie[];
}

export interface BrowserManagerPort {
  acquire(options: BrowserLaunchOptions): Promise<Result<BrowserPort>>;
  release(sessionId: string): Promise<void>;
  get(sessionId: string): BrowserPort | undefined;
  shutdown(): Promise<void>;
}

/** Translates the structured selector DSL into engine-native locators. */
export interface LocatorAdapterPort {
  supports(selector: SelectorDefinition): boolean;
}
