import type { BrowserLaunchOptions, BrowserManagerPort, BrowserPort } from '@runner/application';
import type { ExecutionPlan } from '@runner/domain';
import { ok, type Logger, type Result } from '@runner/shared';
import type { AuthService } from '../auth/auth-service.js';

/**
 * Owns browser session lifetime and authenticated session reuse
 * (blueprint section 9).
 *
 * It sits between the execution pipeline and BrowserManagerPort so that
 * "give me a browser for this plan" and "give me a browser already logged in as
 * MANAGER" are the same call from the caller's point of view.
 *
 * When a plan names an auth profile, a stored session for that profile is
 * applied at launch, so the run starts already authenticated and no UI login is
 * replayed. When there is nothing stored, the browser launches clean and the
 * `authenticated` precondition performs the login — which then captures the
 * state for every run after it.
 */
export class SessionManager {
  constructor(
    private readonly browsers: BrowserManagerPort,
    private readonly logger: Logger,
    /** Absent when no secret provider is configured; auth is then unavailable. */
    private readonly auth?: AuthService,
  ) {}

  async acquireForPlan(plan: ExecutionPlan): Promise<Result<AcquiredBrowser>> {
    const options: BrowserLaunchOptions = {
      headless: plan.options.headless,
      viewport: plan.options.viewport,
      ...(plan.options.baseUrl === undefined ? {} : { baseUrl: plan.options.baseUrl }),
      defaultTimeoutMs: plan.options.defaultTimeoutMs,
    };

    const restored = await this.storageStateFor(plan);

    const acquired = await this.browsers.acquire({
      ...options,
      ...(restored === undefined ? {} : { storageState: restored }),
    });
    if (!acquired.ok) return acquired;

    return ok({
      browser: acquired.value,
      // Reported back so the pipeline can set `authenticatedAs` and the
      // precondition handler knows a login is unnecessary. Claiming it without
      // having restored anything would skip a login the run actually needs.
      authenticatedAs: restored === undefined ? undefined : plan.authProfileRef,
    });
  }

  /**
   * A browser for a page inspection, which has no plan behind it.
   *
   * Inspection is always headless and always read-only: it navigates and
   * reads, never drives. Keeping it a separate entry point rather than
   * synthesizing a fake ExecutionPlan means an inspection can never
   * accidentally inherit execution-only behaviour such as artifact capture.
   *
   * A stored session is still applied when one is asked for, because inspecting
   * a page behind a login is a normal request — but an inspection never **
   * performs** a login, since nothing would be driving the form.
   */
  async acquireForInspection(
    options: BrowserLaunchOptions,
    auth?: { readonly workspaceRef: string; readonly profileRef: string },
  ): Promise<Result<BrowserPort>> {
    if (auth === undefined || this.auth === undefined) {
      return this.browsers.acquire(options);
    }

    const stored = await this.auth.storageStateFor(auth.workspaceRef, auth.profileRef);
    if (!stored.ok) return stored;

    if (stored.value === undefined) {
      this.logger.warn(
        'An inspection asked for an auth profile with no stored session; inspecting unauthenticated.',
        { profileRef: auth.profileRef },
      );
      return this.browsers.acquire(options);
    }

    return this.browsers.acquire({ ...options, storageState: stored.value });
  }

  async release(sessionId: string): Promise<Result<void>> {
    await this.browsers.release(sessionId);
    return ok(undefined);
  }

  /** The stored session for a plan's profile, when there is one to reuse. */
  private async storageStateFor(plan: ExecutionPlan): Promise<unknown | undefined> {
    const profileRef = plan.authProfileRef;
    if (profileRef === undefined) return undefined;

    if (this.auth === undefined) {
      this.logger.warn(
        'An auth profile was requested but no secret provider is configured; continuing unauthenticated.',
        { runId: plan.executionId, authProfileRef: profileRef },
      );
      return undefined;
    }

    const stored = await this.auth.storageStateFor(plan.workspaceRef, profileRef);
    if (!stored.ok) {
      // A cache read failure must not fail the run: the login can still be
      // performed by the precondition handler.
      this.logger.warn('Could not read a stored session; will authenticate instead.', {
        runId: plan.executionId,
        authProfileRef: profileRef,
        errorCode: stored.error.code,
      });
      return undefined;
    }

    if (stored.value !== undefined) {
      this.logger.info('Starting authenticated from a stored session', {
        runId: plan.executionId,
        authProfileRef: profileRef,
      });
    }
    return stored.value;
  }
}

/** A browser plus what the Runner knows about its authentication. */
export interface AcquiredBrowser {
  readonly browser: BrowserPort;
  /** Set when a stored session was applied at launch. */
  readonly authenticatedAs?: string;
}
