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
}

export interface ScreenshotOptions {
  readonly fullPage?: boolean;
  readonly format?: 'png' | 'jpeg';
  readonly quality?: number;
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

  screenshot(options?: ScreenshotOptions): Promise<Result<Buffer>>;

  /** Draws a transient overlay for the live workspace. */
  highlight(selector: ScopedSelector, durationMs?: number): Promise<Result<void>>;

  close(): Promise<void>;
}

export interface BrowserLaunchOptions {
  readonly headless: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly baseUrl?: string;
  /** Serialized cookies/localStorage restoring an authenticated session. */
  readonly storageState?: unknown;
  readonly defaultTimeoutMs?: number;
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
