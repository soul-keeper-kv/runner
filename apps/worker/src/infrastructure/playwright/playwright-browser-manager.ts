import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { BrowserLaunchOptions, BrowserManagerPort, BrowserPort } from '@runner/application';
import { RunnerErrors, err, newId, ok, type Logger, type Result } from '@runner/shared';
import { PlaywrightBrowserAdapter } from './playwright-browser-adapter.js';

/** The shape Playwright accepts for a restored storage state. */
type BrowserContextStorageState = NonNullable<
  NonNullable<Parameters<Browser['newContext']>[0]>['storageState']
>;

/**
 * Owns the Playwright browser process and hands out isolated contexts.
 *
 * One browser process, many BrowserContexts. Contexts are cheap and fully
 * isolated, so every execution and every live session gets its own — which is
 * what blueprint section 50 requires: cookies, storage and authentication state
 * must never leak between runs, profiles or tenants.
 */
export class PlaywrightBrowserManager implements BrowserManagerPort {
  private browser: Browser | undefined;
  private readonly sessions = new Map<string, { adapter: BrowserPort; context: BrowserContext }>();

  constructor(private readonly logger: Logger) {}

  async acquire(options: BrowserLaunchOptions): Promise<Result<BrowserPort>> {
    try {
      const browser = await this.ensureBrowser(options.headless);

      const context = await browser.newContext({
        viewport: options.viewport,
        ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
        // Restores a previously authenticated session without replaying a UI
        // login (blueprint section 9). The port keeps this `unknown` so the
        // application layer never depends on Playwright's storage-state shape.
        ...(options.storageState === undefined
          ? {}
          : { storageState: options.storageState as BrowserContextStorageState }),
        // Set at launch when the profile is known up front, which is the common
        // case for an execution. A live session authenticating later goes
        // through BrowserPort.setExtraHeaders instead, because it must not
        // restart the context it is investigating.
        ...(options.extraHeaders === undefined
          ? {}
          : { extraHTTPHeaders: { ...options.extraHeaders } }),
      });

      if (options.cookies !== undefined && options.cookies.length > 0) {
        await context.addCookies(
          options.cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            ...(cookie.url === undefined ? {} : { url: cookie.url }),
            ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
            path: cookie.path ?? '/',
            ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
            ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
            ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
            ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
          })),
        );
      }

      const defaultTimeout = options.defaultTimeoutMs ?? 15_000;
      context.setDefaultTimeout(defaultTimeout);

      const page = await context.newPage();
      const sessionId = newId('bs');
      const adapter = new PlaywrightBrowserAdapter(
        sessionId,
        context,
        page,
        this.logger.child({ sessionId }),
        defaultTimeout,
      );

      this.sessions.set(sessionId, { adapter, context });
      this.logger.info('Browser session acquired', { sessionId, headless: options.headless });
      return ok(adapter);
    } catch (cause) {
      return err(
        RunnerErrors.browserCrashed(
          cause instanceof Error ? cause.message : 'Could not launch a browser context.',
        ),
      );
    }
  }

  async release(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;

    await session.adapter.close();
    this.sessions.delete(sessionId);
    this.logger.info('Browser session released', { sessionId });
  }

  get(sessionId: string): BrowserPort | undefined {
    return this.sessions.get(sessionId)?.adapter;
  }

  async shutdown(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.release(sessionId);
    }

    if (this.browser !== undefined) {
      await this.browser.close();
      this.browser = undefined;
      this.logger.info('Browser process closed');
    }
  }

  /**
   * Launches the browser on first use.
   *
   * Lazy rather than eager so a worker that never receives a job — or one whose
   * only job fails validation — does not pay for a browser process.
   */
  private async ensureBrowser(headless: boolean): Promise<Browser> {
    if (this.browser !== undefined && this.browser.isConnected()) return this.browser;

    this.browser = await chromium.launch({
      headless,
      args: ['--disable-dev-shm-usage'],
    });

    this.browser.on('disconnected', () => {
      this.logger.error('Browser process disconnected unexpectedly');
      this.browser = undefined;
      this.sessions.clear();
    });

    return this.browser;
  }
}
