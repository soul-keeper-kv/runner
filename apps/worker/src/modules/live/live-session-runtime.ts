import type { BrowserManagerPort, BrowserPort, SessionStorePort } from '@runner/application';
import type { LiveCommandResult, RawLiveCommand } from '@runner/live-protocol';
import { ok, type Clock, type Logger, type Result } from '@runner/shared';
import type { CapabilityRegistry, LiveSessionContext } from '../../capabilities/capability-registry.js';

/**
 * Holds a browser open per live session and dispatches commands against it
 * (blueprint sections 25, 26 and 28).
 *
 * The one property this class exists to guarantee: **a command never restarts
 * the browser**. Cookies, the current URL, scroll position, the open modal and
 * half-filled form fields all survive from one command to the next, because
 * that state is usually what made a selector worth checking. A runtime that
 * acquired a fresh context per command would look correct in tests and be
 * useless in practice — the user would be debugging a different page.
 *
 * A live browser is therefore acquired lazily on the session's first command
 * and kept until the session is closed or reaped.
 */

export interface LiveSessionRuntimeOptions {
  readonly headless: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly defaultTimeoutMs: number;
  /** A session idle this long is reaped; a held browser is expensive. */
  readonly idleTimeoutMs: number;
}

export const DEFAULT_LIVE_RUNTIME_OPTIONS: LiveSessionRuntimeOptions = {
  headless: true,
  viewport: { width: 1280, height: 720 },
  defaultTimeoutMs: 15_000,
  idleTimeoutMs: 30 * 60 * 1000,
};

interface HeldSession {
  readonly browser: BrowserPort;
  lastUsedAtMs: number;
}

export class LiveSessionRuntime {
  private readonly held = new Map<string, HeldSession>();
  /**
   * In-flight acquisitions, so two commands arriving together for a new session
   * cannot each launch a browser context and leak one.
   */
  private readonly acquiring = new Map<string, Promise<Result<BrowserPort>>>();

  constructor(
    private readonly browsers: BrowserManagerPort,
    private readonly sessions: SessionStorePort,
    private readonly capabilities: CapabilityRegistry,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: LiveSessionRuntimeOptions = DEFAULT_LIVE_RUNTIME_OPTIONS,
  ) {}

  /**
   * Serves one live command.
   *
   * Always resolves to a `LiveCommandResult` rather than throwing: the result is
   * a protocol message the client renders, and a failure to dispatch is as much
   * an answer as a success.
   */
  async handle(command: RawLiveCommand): Promise<LiveCommandResult> {
    const session = await this.sessions.get(command.sessionId);
    if (!session.ok) {
      return this.failure(command, session.error.code, session.error.message, 0);
    }

    if (session.value.executionState === 'CLOSED') {
      return this.failure(
        command,
        'LIVE_SESSION_LOST',
        `Live session "${command.sessionId}" is closed.`,
        session.value.revision,
      );
    }

    const browser = await this.browserFor(command.sessionId);
    if (!browser.ok) {
      return this.failure(
        command,
        browser.error.code,
        browser.error.message,
        session.value.revision,
      );
    }

    const context: LiveSessionContext = {
      session: session.value,
      browser: browser.value,
      logger: this.logger.child({ sessionId: command.sessionId }),
    };

    const dispatched = await this.capabilities.dispatch(command, context);

    // Only an applied command advances the session: bumping the revision on a
    // failure would make a client believe it had missed an update.
    const revision = dispatched.ok
      ? await this.touch(command.sessionId, session.value.revision)
      : session.value.revision;

    if (!dispatched.ok) {
      return this.failure(
        command,
        dispatched.error.code,
        dispatched.error.message,
        revision,
        dispatched.error.details,
      );
    }

    return {
      commandId: command.id,
      sessionId: command.sessionId,
      ok: true,
      result: dispatched.value,
      completedAt: this.clock.nowIso(),
      revision,
    };
  }

  /** Releases a session's browser. Called when a session closes or is reaped. */
  async release(sessionId: string): Promise<void> {
    const session = this.held.get(sessionId);
    if (session === undefined) return;

    this.held.delete(sessionId);
    await this.browsers.release(session.browser.sessionId);
    this.logger.info('Live session browser released', { sessionId });
  }

  /**
   * Releases every session idle beyond the timeout.
   *
   * A live session pins a browser context, so an abandoned tab must not hold
   * one indefinitely. The API's session TTL and this reaper are deliberately
   * independent: either process can lose the other without leaking a browser.
   */
  async reapIdle(): Promise<number> {
    const cutoff = this.clock.now() - this.options.idleTimeoutMs;
    const stale = [...this.held.entries()].filter(([, held]) => held.lastUsedAtMs < cutoff);

    for (const [sessionId] of stale) {
      this.logger.info('Reaping an idle live session', { sessionId });
      await this.release(sessionId);
    }
    return stale.length;
  }

  async shutdown(): Promise<void> {
    for (const sessionId of [...this.held.keys()]) {
      await this.release(sessionId);
    }
  }

  /** Sessions currently holding a browser. */
  activeSessions(): string[] {
    return [...this.held.keys()];
  }

  /**
   * Returns the session's browser, acquiring one on first use.
   *
   * The `acquiring` map deduplicates concurrent first commands; without it a
   * burst of two would each acquire a context and one would be orphaned.
   */
  private async browserFor(sessionId: string): Promise<Result<BrowserPort>> {
    const existing = this.held.get(sessionId);
    if (existing !== undefined) {
      existing.lastUsedAtMs = this.clock.now();
      return ok(existing.browser);
    }

    const inFlight = this.acquiring.get(sessionId);
    if (inFlight !== undefined) return inFlight;

    const acquisition = this.acquireFor(sessionId);
    this.acquiring.set(sessionId, acquisition);

    try {
      return await acquisition;
    } finally {
      this.acquiring.delete(sessionId);
    }
  }

  private async acquireFor(sessionId: string): Promise<Result<BrowserPort>> {
    const acquired = await this.browsers.acquire({
      headless: this.options.headless,
      viewport: this.options.viewport,
      defaultTimeoutMs: this.options.defaultTimeoutMs,
      // Phase 5: a session started from an auth profile resolves its stored
      // storageState here, so the live browser opens already authenticated.
    });

    if (!acquired.ok) return acquired;

    this.held.set(sessionId, {
      browser: acquired.value,
      lastUsedAtMs: this.clock.now(),
    });

    this.logger.info('Live session browser acquired', {
      sessionId,
      browserSessionId: acquired.value.sessionId,
    });
    return ok(acquired.value);
  }

  /** Records that the session was used, returning its new revision. */
  private async touch(sessionId: string, fallbackRevision: number): Promise<number> {
    const updated = await this.sessions.update(sessionId, {
      updatedAt: this.clock.nowIso(),
    });
    return updated.ok ? updated.value.revision : fallbackRevision;
  }

  private failure(
    command: RawLiveCommand,
    code: string,
    message: string,
    revision: number,
    details?: Record<string, unknown>,
  ): LiveCommandResult {
    return {
      commandId: command.id,
      sessionId: command.sessionId,
      ok: false,
      error: { code, message, ...(details === undefined ? {} : { details }) },
      completedAt: this.clock.nowIso(),
      revision,
    };
  }
}
