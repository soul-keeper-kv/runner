import type {
  BrowserManagerPort,
  BrowserPort,
  EventBusPort,
  SessionStorePort,
} from '@runner/application';
import type { LiveCommandResult, LiveSession, RawLiveCommand } from '@runner/live-protocol';
import { newEventId, ok, type Clock, type Logger, type Result } from '@runner/shared';
import type { CapabilityRegistry, LiveSessionContext } from '../../capabilities/capability-registry.js';
import type { AuthService } from '../auth/auth-service.js';

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
  /*
   * Deliberately shorter than an execution's timeout.
   *
   * A live command holds a user's attention: an unreachable page spent 15s
   * before reporting PAGE_NOT_REACHABLE, and the snapshot behind it spent
   * another 15s failing to capture a frame, so the preview froze for half a
   * minute with nothing on screen explaining why. Answering in 8s is worth
   * more here than waiting out a page that is probably not coming.
   *
   * Execution and auth keep their own 15s: a real test step waits on slow
   * application behaviour that a person watching a preview would not.
   */
  defaultTimeoutMs: 8_000,
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
    /**
     * Absent when no secret provider is configured, in which case a session
     * that names a profile opens unauthenticated and says so.
     */
    private readonly auth?: AuthService,
    /**
     * Carries events out of this process, so a streamed frame can reach the
     * API's socket. Absent when nothing cross-process is configured, in which
     * case a capability that streams refuses rather than streaming into a bus
     * only this process can hear.
     */
    private readonly events?: EventBusPort,
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

    const browser = await this.browserFor(command.sessionId, session.value);
    if (!browser.ok) {
      return this.failure(
        command,
        browser.error.code,
        browser.error.message,
        session.value.revision,
      );
    }

    /*
     * Re-read after acquiring, because acquiring can *change* the session:
     * restoring a stored session sets `authenticatedAs`. The record read at the
     * top of this method predates that, and a capability handed it would report
     * a session that is authenticated as not authenticated — the exact
     * confusion `authenticatedAs` exists to prevent.
     *
     * Only the first command of a session pays for this second read; every
     * later one finds the browser already held and skips it.
     */
    const current = await this.sessions.get(command.sessionId);
    const live = current.ok ? current.value : session.value;

    // A capability may change the session itself — so far only `auth`, setting
    // `authenticatedAs`. Collected here and written once, with the same update
    // that advances the revision, so there is a single writer.
    let sessionPatch: Partial<Pick<LiveSession, 'authenticatedAs'>> | undefined;

    const events = this.events;

    const context: LiveSessionContext = {
      session: live,
      browser: browser.value,
      logger: this.logger.child({ sessionId: command.sessionId }),
      patchSession: (patch) => {
        sessionPatch = { ...sessionPatch, ...patch };
      },
      ...(events === undefined
        ? {}
        : {
            publishEvent: (event) => {
              /*
               * Fire-and-forget on purpose.
               *
               * A frame arrives from the engine's callback, not from a command,
               * so there is nobody to await it — and a stream that waited for
               * each publish would let Redis latency set the frame rate. A
               * dropped frame costs one repaint; a stalled stream costs the
               * feature.
               */
              void events.publish({
                id: newEventId(),
                sessionId: command.sessionId,
                type: event.type,
                // Frames are a stream, not a log: a client that misses one
                // wants the next, never a replay, so there is no per-session
                // counter to keep here.
                sequence: 0,
                timestamp: this.clock.nowIso(),
                payload: event.payload,
              });
            },
          }),
    };

    const dispatched = await this.capabilities.dispatch(command, context);

    // Only an applied command advances the session: bumping the revision on a
    // failure would make a client believe it had missed an update.
    const revision = dispatched.ok
      ? await this.touch(command.sessionId, live.revision, sessionPatch)
      : live.revision;

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

    /*
     * Before the context goes: a screencast left running would keep Chrome
     * producing frames for a session nobody can watch, and the detach would
     * then race the context teardown.
     *
     * Guarded rather than called outright. Releasing a browser must not depend
     * on how new its adapter is — a BrowserPort built before streaming existed
     * throws a TypeError here, and losing a browser context because it could
     * not be asked to stop a stream it never started would be a bad trade.
     */
    if (typeof session.browser.stopScreencast === 'function') {
      await Promise.resolve(session.browser.stopScreencast()).catch(() => undefined);
    }

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
  private async browserFor(
    sessionId: string,
    session: LiveSession,
  ): Promise<Result<BrowserPort>> {
    const existing = this.held.get(sessionId);
    if (existing !== undefined) {
      existing.lastUsedAtMs = this.clock.now();
      return ok(existing.browser);
    }

    const inFlight = this.acquiring.get(sessionId);
    if (inFlight !== undefined) return inFlight;

    const acquisition = this.acquireFor(sessionId, session);
    this.acquiring.set(sessionId, acquisition);

    try {
      return await acquisition;
    } finally {
      this.acquiring.delete(sessionId);
    }
  }

  private async acquireFor(
    sessionId: string,
    session: LiveSession,
  ): Promise<Result<BrowserPort>> {
    // Phase 5: a session started from an auth profile opens with that
    // profile's stored session applied, so the live view lands on the page the
    // user asked for instead of on a login screen.
    const storageState = await this.storageStateFor(session);

    const acquired = await this.browsers.acquire({
      headless: this.options.headless,
      viewport: this.options.viewport,
      defaultTimeoutMs: this.options.defaultTimeoutMs,
      ...(storageState === undefined ? {} : { storageState }),
    });

    if (!acquired.ok) return acquired;

    this.held.set(sessionId, {
      browser: acquired.value,
      lastUsedAtMs: this.clock.now(),
    });

    // Claimed only when a session was actually restored. Recording it
    // optimistically would let `auth.login` skip the login the session needs.
    if (storageState !== undefined && session.authProfileRef !== undefined) {
      await this.sessions.update(sessionId, { authenticatedAs: session.authProfileRef });
    }

    this.logger.info('Live session browser acquired', {
      sessionId,
      browserSessionId: acquired.value.sessionId,
      ...(session.authProfileRef === undefined
        ? {}
        : { authProfileRef: session.authProfileRef, authenticated: storageState !== undefined }),
    });
    return ok(acquired.value);
  }

  /**
   * The stored session for this live session's profile, when there is one.
   *
   * Every miss is a warning rather than a failure, and the browser still opens:
   * `auth.login` can perform the login into the very browser the user is
   * watching. Refusing to open one would leave them with no way to authenticate
   * at all.
   */
  private async storageStateFor(session: LiveSession): Promise<unknown | undefined> {
    const profileRef = session.authProfileRef;
    if (profileRef === undefined) return undefined;

    if (this.auth === undefined) {
      this.logger.warn(
        'A live session named an auth profile but no secret provider is configured; opening unauthenticated.',
        { sessionId: session.id, authProfileRef: profileRef },
      );
      return undefined;
    }

    const stored = await this.auth.storageStateFor(session.workspaceRef, profileRef);
    if (!stored.ok) {
      this.logger.warn('Could not read a stored session for a live session.', {
        sessionId: session.id,
        authProfileRef: profileRef,
        errorCode: stored.error.code,
      });
      return undefined;
    }

    if (stored.value === undefined) {
      this.logger.info(
        'No stored session for this profile yet; the live browser opens unauthenticated. Send auth.login to log in.',
        { sessionId: session.id, authProfileRef: profileRef },
      );
    }
    return stored.value;
  }

  /** Records that the session was used, returning its new revision. */
  private async touch(
    sessionId: string,
    fallbackRevision: number,
    patch?: Partial<Pick<LiveSession, 'authenticatedAs'>>,
  ): Promise<number> {
    const updated = await this.sessions.update(sessionId, {
      updatedAt: this.clock.nowIso(),
      ...patch,
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
