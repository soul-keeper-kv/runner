import { describe, expect, it } from 'vitest';
import type { BrowserManagerPort, BrowserPort, SessionStorePort } from '@runner/application';
import type { LiveSession, RawLiveCommand } from '@runner/live-protocol';
import { fixedClock, noopLogger, ok, err, RunnerErrors, type Result } from '@runner/shared';
import {
  CapabilityRegistry,
  type LiveCapability,
  type LiveSessionContext,
} from '../src/capabilities/capability-registry.js';
import { LiveSessionRuntime } from '../src/modules/live/live-session-runtime.js';

/**
 * The property these tests exist to protect: a live session's browser is held
 * open across commands. A runtime that re-acquired per command would pass a
 * naive "does it dispatch" test and be useless in practice, because the user
 * would be editing a selector against a page that had lost its state.
 *
 * Everything is faked through ports, so no browser launches.
 */

const SESSION_ID = 'ls_test';

function sessionWith(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    id: SESSION_ID,
    workspaceRef: 'workspace_checkout',
    browserSessionId: 'bs_reserved',
    executionState: 'IDLE',
    revision: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Counts acquisitions, so "held open" is observable rather than assumed. */
function fakeBrowsers() {
  let acquisitions = 0;
  let released: string[] = [];

  const manager: BrowserManagerPort = {
    acquire: async () => {
      acquisitions += 1;
      return ok({ sessionId: `bs_${acquisitions}` } as unknown as BrowserPort);
    },
    release: async (sessionId: string) => {
      released.push(sessionId);
    },
    get: () => undefined,
    shutdown: async () => undefined,
  };

  return {
    manager,
    get acquisitions() {
      return acquisitions;
    },
    get released() {
      return released;
    },
  };
}

function fakeSessions(session: LiveSession | undefined) {
  let current = session;
  let updates = 0;

  const store: SessionStorePort = {
    create: async (value) => ok(value),
    get: async (sessionId) =>
      current === undefined
        ? err(RunnerErrors.liveSessionLost(sessionId))
        : ok(current),
    update: async (_sessionId, patch) => {
      updates += 1;
      if (current === undefined) return err(RunnerErrors.liveSessionLost(_sessionId));
      current = { ...current, ...patch, revision: current.revision + 1 };
      return ok(current);
    },
    delete: async () => ok(undefined),
    listByWorkspace: async () => ok(current === undefined ? [] : [current]),
    touch: async () => ok(undefined),
  };

  return {
    store,
    get updates() {
      return updates;
    },
    /** The session as the store now holds it, so a write is observable. */
    get current() {
      return current;
    },
  };
}

/** A capability that records the browser it was handed. */
function recordingCapability(result: Result<unknown> = ok({ done: true })) {
  const seen: { browserSessionId: string }[] = [];

  const capability: LiveCapability = {
    type: 'browser',
    handles: ['browser.navigate', 'browser.refresh'],
    execute: async (_command: RawLiveCommand, context: LiveSessionContext) => {
      seen.push({ browserSessionId: context.browser.sessionId });
      return result;
    },
  };

  return { capability, seen };
}

function commandOf(type: string, id = 'cmd_1'): RawLiveCommand {
  return { id, sessionId: SESSION_ID, type, payload: {} };
}

function runtimeWith(options: {
  session?: LiveSession | undefined;
  result?: Result<unknown>;
  registerCapability?: boolean;
}) {
  const clock = fixedClock('2026-01-01T00:00:00.000Z');
  const browsers = fakeBrowsers();
  const sessions = fakeSessions('session' in options ? options.session : sessionWith());
  const capabilities = new CapabilityRegistry(noopLogger);
  const recorder = recordingCapability(options.result ?? ok({ done: true }));

  if (options.registerCapability !== false) capabilities.register(recorder.capability);

  const runtime = new LiveSessionRuntime(
    browsers.manager,
    sessions.store,
    capabilities,
    clock,
    noopLogger,
  );

  return { runtime, browsers, sessions, recorder, clock };
}

describe('holding the browser open', () => {
  it('acquires one browser and reuses it across commands', async () => {
    const { runtime, browsers, recorder } = runtimeWith({});

    await runtime.handle(commandOf('browser.navigate', 'cmd_1'));
    await runtime.handle(commandOf('browser.refresh', 'cmd_2'));
    await runtime.handle(commandOf('browser.navigate', 'cmd_3'));

    // The whole point of a live session: editing does not restart the page.
    expect(browsers.acquisitions).toBe(1);
    expect(recorder.seen.map((entry) => entry.browserSessionId)).toEqual([
      'bs_1',
      'bs_1',
      'bs_1',
    ]);
  });

  it('does not acquire two browsers for commands that arrive together', async () => {
    const { runtime, browsers } = runtimeWith({});

    await Promise.all([
      runtime.handle(commandOf('browser.navigate', 'cmd_a')),
      runtime.handle(commandOf('browser.refresh', 'cmd_b')),
    ]);

    expect(browsers.acquisitions).toBe(1);
  });

  it('reports the session as active while it holds a browser', async () => {
    const { runtime } = runtimeWith({});
    expect(runtime.activeSessions()).toEqual([]);

    await runtime.handle(commandOf('browser.navigate'));
    expect(runtime.activeSessions()).toEqual([SESSION_ID]);
  });

  it('releases the browser when the session is released', async () => {
    const { runtime, browsers } = runtimeWith({});
    await runtime.handle(commandOf('browser.navigate'));

    await runtime.release(SESSION_ID);

    expect(browsers.released).toEqual(['bs_1']);
    expect(runtime.activeSessions()).toEqual([]);
  });

  it('acquires a fresh browser after a release, rather than reusing a closed one', async () => {
    const { runtime, browsers } = runtimeWith({});
    await runtime.handle(commandOf('browser.navigate'));
    await runtime.release(SESSION_ID);

    await runtime.handle(commandOf('browser.navigate', 'cmd_2'));

    expect(browsers.acquisitions).toBe(2);
  });
});

describe('dispatching a command', () => {
  it('returns the capability result and the new session revision', async () => {
    const { runtime } = runtimeWith({ result: ok({ matchCount: 1 }) });

    const result = await runtime.handle(commandOf('browser.navigate'));

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ matchCount: 1 });
    expect(result.commandId).toBe('cmd_1');
    // The session started at revision 3; an applied command advances it.
    expect(result.revision).toBe(4);
  });

  it('does not advance the revision when a command fails', async () => {
    // A client uses `revision` to detect updates it missed, so bumping it for a
    // command that changed nothing would make it believe it had fallen behind.
    const { runtime, sessions } = runtimeWith({
      result: err(RunnerErrors.selectorInvalid('css', 'unbalanced bracket')),
    });

    const result = await runtime.handle(commandOf('browser.navigate'));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SELECTOR_INVALID');
    expect(result.revision).toBe(3);
    expect(sessions.updates).toBe(0);
  });

  it('reports an unregistered command precisely instead of failing generically', async () => {
    const { runtime } = runtimeWith({ registerCapability: false });

    const result = await runtime.handle(commandOf('browser.navigate'));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('LIVE_COMMAND_UNSUPPORTED');
  });

  it('refuses a command for a session that does not exist', async () => {
    const { runtime, browsers } = runtimeWith({ session: undefined });

    const result = await runtime.handle(commandOf('browser.navigate'));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('LIVE_SESSION_LOST');
    // And it must not have launched a browser for a session it cannot serve.
    expect(browsers.acquisitions).toBe(0);
  });

  it('refuses a command for a closed session', async () => {
    const { runtime, browsers } = runtimeWith({
      session: sessionWith({ executionState: 'CLOSED' }),
    });

    const result = await runtime.handle(commandOf('browser.navigate'));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('LIVE_SESSION_LOST');
    expect(browsers.acquisitions).toBe(0);
  });

  it('always answers, so a waiting client is never left to time out', async () => {
    const { runtime } = runtimeWith({ session: undefined });

    const result = await runtime.handle(commandOf('browser.navigate', 'cmd_x'));

    expect(result.commandId).toBe('cmd_x');
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.completedAt).toBeTypeOf('string');
  });
});

describe('reaping idle sessions', () => {
  it('releases a session idle past the timeout', async () => {
    const { runtime, browsers, clock } = runtimeWith({});
    await runtime.handle(commandOf('browser.navigate'));

    clock.advance(31 * 60 * 1000);
    const reaped = await runtime.reapIdle();

    expect(reaped).toBe(1);
    expect(browsers.released).toEqual(['bs_1']);
  });

  it('keeps a session that is still being used', async () => {
    const { runtime, browsers, clock } = runtimeWith({});
    await runtime.handle(commandOf('browser.navigate'));

    clock.advance(10 * 60 * 1000);
    expect(await runtime.reapIdle()).toBe(0);
    expect(browsers.released).toEqual([]);
  });

  it('treats each command as fresh activity', async () => {
    const { runtime, clock } = runtimeWith({});
    await runtime.handle(commandOf('browser.navigate', 'cmd_1'));

    clock.advance(25 * 60 * 1000);
    await runtime.handle(commandOf('browser.refresh', 'cmd_2'));
    clock.advance(25 * 60 * 1000);

    // 50 minutes since the first command, but only 25 since the last.
    expect(await runtime.reapIdle()).toBe(0);
  });

  it('releases every held browser on shutdown', async () => {
    const { runtime, browsers } = runtimeWith({});
    await runtime.handle(commandOf('browser.navigate'));

    await runtime.shutdown();

    expect(browsers.released).toEqual(['bs_1']);
    expect(runtime.activeSessions()).toEqual([]);
  });
});

/**
 * Phase 5 in a live session.
 *
 * The bug these pin: `acquireFor` carried a "Phase 5 resolves storageState
 * here" comment and no code, so a session started with an auth profile opened a
 * clean browser and every navigation landed on a login page — while every test
 * above still passed, because none of them named a profile.
 */
describe('opening a live session authenticated', () => {
  /** Records the launch options, so an applied session is observable. */
  function recordingBrowsers() {
    const launches = [];

    const manager = {
      acquire: async (options) => {
        launches.push(options);
        return ok({ sessionId: `bs_${launches.length}` });
      },
      release: async () => undefined,
      get: () => undefined,
      shutdown: async () => undefined,
    };

    return { manager, launches };
  }

  function authWith(state) {
    return {
      storageStateFor: async () => ok(state),
    };
  }

  function runtimeFor(session, auth) {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const browsers = recordingBrowsers();
    const sessions = fakeSessions(session);
    const capabilities = new CapabilityRegistry(noopLogger);
    capabilities.register(recordingCapability().capability);

    const runtime = new LiveSessionRuntime(
      browsers.manager,
      sessions.store,
      capabilities,
      clock,
      noopLogger,
      undefined,
      auth,
    );

    return { runtime, browsers, sessions };
  }

  it('applies the profile stored session, so a gated page renders', async () => {
    const stored = { cookies: [{ name: 'session', value: 'restored' }] };
    const { runtime, browsers } = runtimeFor(
      sessionWith({ authProfileRef: 'MANAGER' }),
      authWith(stored),
    );

    await runtime.handle(commandOf('browser.navigate'));

    expect(browsers.launches).toHaveLength(1);
    expect(browsers.launches[0]?.storageState).toEqual(stored);
  });

  it('records the session as authenticated only when one was restored', async () => {
    const { runtime, sessions } = runtimeFor(
      sessionWith({ authProfileRef: 'MANAGER' }),
      authWith({ cookies: [] }),
    );

    await runtime.handle(commandOf('browser.navigate'));

    expect(sessions.current?.authenticatedAs).toBe('MANAGER');
  });

  it('opens unauthenticated when nothing is stored yet, rather than refusing', async () => {
    // auth.login can then log in *into this browser*. Refusing to open one
    // would leave a user with no way to authenticate at all.
    const { runtime, browsers, sessions } = runtimeFor(
      sessionWith({ authProfileRef: 'MANAGER' }),
      authWith(undefined),
    );

    const result = await runtime.handle(commandOf('browser.navigate'));

    expect(result.ok).toBe(true);
    expect(browsers.launches[0]?.storageState).toBeUndefined();
    // And it must not claim an authentication that never happened.
    expect(sessions.current?.authenticatedAs).toBeUndefined();
  });

  it('does not claim authentication when no secret provider is configured', async () => {
    const { runtime, browsers, sessions } = runtimeFor(
      sessionWith({ authProfileRef: 'MANAGER' }),
      undefined,
    );

    const result = await runtime.handle(commandOf('browser.navigate'));

    expect(result.ok).toBe(true);
    expect(browsers.launches[0]?.storageState).toBeUndefined();
    expect(sessions.current?.authenticatedAs).toBeUndefined();
  });

  it('launches a clean browser for a session with no profile', async () => {
    const { runtime, browsers } = runtimeFor(sessionWith(), authWith({ cookies: [] }));

    await runtime.handle(commandOf('browser.navigate'));

    // A session that asked for nothing must not inherit another profile's
    // cookies: that would leak one tenant's authentication into another view.
    expect(browsers.launches[0]?.storageState).toBeUndefined();
  });

  it('persists what a capability changed about the session', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const browsers = recordingBrowsers();
    const sessions = fakeSessions(sessionWith({ authProfileRef: 'MANAGER' }));
    const capabilities = new CapabilityRegistry(noopLogger);

    // Stands in for AuthCapability: it reports a completed login through the
    // context rather than writing to the store, so the runtime stays the only
    // writer of the session record.
    capabilities.register({
      type: 'auth',
      handles: ['auth.login'],
      execute: async (_command, context) => {
        context.patchSession?.({ authenticatedAs: 'MANAGER' });
        return ok({ fromStoredSession: false });
      },
    });

    const runtime = new LiveSessionRuntime(
      browsers.manager,
      sessions.store,
      capabilities,
      clock,
      noopLogger,
      undefined,
      authWith(undefined),
    );

    await runtime.handle(commandOf('auth.login'));

    expect(sessions.current?.authenticatedAs).toBe('MANAGER');
  });
});

/**
 * The reporting bug this pins: a live session opened from a stored session
 * reported itself as *not* authenticated on its first command.
 *
 * `acquireFor` sets `authenticatedAs` when it restores a session, but the
 * record the runtime read before acquiring predates that write — so the first
 * capability to run was handed a stale session and answered "not
 * authenticated" about a browser that was already logged in. Exactly the
 * confusion `authenticatedAs` exists to prevent, and only visible in a real run.
 */
describe('what a capability is told about the session', () => {
  it('sees the authentication that acquiring the browser just recorded', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const browsers = fakeBrowsers();
    const sessions = fakeSessions(sessionWith({ authProfileRef: 'MANAGER' }));
    const capabilities = new CapabilityRegistry(noopLogger);

    const seen = [];
    capabilities.register({
      type: 'auth',
      handles: ['auth.status'],
      execute: async (_command, context) => {
        seen.push(context.session.authenticatedAs);
        return ok({ fromStoredSession: context.session.authenticatedAs !== undefined });
      },
    });

    const runtime = new LiveSessionRuntime(
      browsers.manager,
      sessions.store,
      capabilities,
      clock,
      noopLogger,
      undefined,
      { storageStateFor: async () => ok({ cookies: [] }) },
    );

    const result = await runtime.handle(commandOf('auth.status'));

    expect(result.ok).toBe(true);
    expect(seen).toEqual(['MANAGER']);
    expect(result.result).toEqual({ fromStoredSession: true });
  });

  it('still answers when the session cannot be re-read', async () => {
    // A store hiccup must not fail a command whose browser is already held.
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const browsers = fakeBrowsers();
    const sessions = fakeSessions(sessionWith());
    const capabilities = new CapabilityRegistry(noopLogger);
    capabilities.register(recordingCapability().capability);

    let reads = 0;
    const flaky = {
      ...sessions.store,
      get: async (sessionId) => {
        reads += 1;
        // The first read succeeds; the re-read after acquiring fails.
        return reads === 1
          ? sessions.store.get(sessionId)
          : err(RunnerErrors.internal('store unavailable'));
      },
    };

    const runtime = new LiveSessionRuntime(
      browsers.manager,
      flaky,
      capabilities,
      clock,
      noopLogger,
    );

    const result = await runtime.handle(commandOf('browser.navigate'));

    expect(result.ok).toBe(true);
  });
});
