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
