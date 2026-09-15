import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { LiveSession } from '@runner/live-protocol';
import { createSchemaRegistry } from '@runner/contracts-internal';
import { RunnerErrors, err, fixedClock, noopLogger, ok, type Result } from '@runner/shared';
import { registerLiveSessionGateway } from '../src/presentation/websocket/live-session.gateway.js';
import type { ApiContainer } from '../src/infrastructure/container.js';

/**
 * What this file protects: **a command sent the instant a socket opens must not
 * be lost.**
 *
 * The bug it pins was invisible and expensive. The gateway attached its
 * `message` listener *after* awaiting the session lookup, and `ws` discards a
 * message that arrives with no listener — so the frame vanished with no error,
 * no log and no reply, and the client sat out its full timeout. A client that
 * sends as soon as the socket opens wins that race against a warm server
 * almost every time, which made the first command of a session disappear while
 * a later one on the same socket worked perfectly. Only a real browser run
 * found it; every unit test and the whole typecheck passed.
 */

const SESSION_ID = 'ls_test';

function sessionWith(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    id: SESSION_ID,
    workspaceRef: 'workspace_demo',
    browserSessionId: 'bs_1',
    executionState: 'IDLE',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A socket that records what was sent and can emit frames on demand. */
function fakeSocket() {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  let closedWith: number | undefined;

  const socket = Object.assign(emitter, {
    send: (raw: string) => sent.push(JSON.parse(raw)),
    close: (code?: number) => {
      closedWith = code;
    },
  });

  return {
    socket,
    sent,
    get closedWith() {
      return closedWith;
    },
    emitMessage(message: unknown) {
      emitter.emit('message', Buffer.from(JSON.stringify(message), 'utf8'));
    },
  };
}

/**
 * Wires the gateway with a session lookup the test controls.
 *
 * `releaseLookup` is what makes the race observable: nothing resolves until the
 * test says so, exactly like a Redis round trip a fast client outruns.
 */
function gatewayWith(options: {
  session?: Result<LiveSession>;
  dispatch?: ReturnType<typeof vi.fn>;
} = {}) {
  let releaseLookup: () => void = () => undefined;
  const lookupReached = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });

  const dispatch =
    options.dispatch ??
    vi.fn(async (command: { id: string; sessionId: string }) =>
      ok({
        commandId: command.id,
        sessionId: command.sessionId,
        ok: true,
        result: { url: 'https://app.test/orders' },
        completedAt: '2026-01-01T00:00:00.000Z',
        revision: 2,
      }),
    );

  const answer = options.session ?? ok(sessionWith());

  const container = {
    logger: noopLogger,
    clock: fixedClock('2026-01-01T00:00:00.000Z'),
    schemas: createSchemaRegistry(),
    sessionStore: {
      get: async () => {
        await lookupReached;
        return answer;
      },
      touch: async () => ok(undefined),
    },
    liveCommands: { dispatch },
  } as unknown as ApiContainer;

  let handler: ((connection: unknown, request: unknown) => void) | undefined;
  const app = {
    get: (_path: string, _opts: unknown, route: (connection: unknown, request: unknown) => void) => {
      handler = route;
    },
  };

  registerLiveSessionGateway(app as never, container);

  const connect = () => {
    const socket = fakeSocket();
    handler?.({ socket: socket.socket }, { params: { sessionId: SESSION_ID } });
    return socket;
  };

  return { connect, releaseLookup, dispatch };
}

/** Lets queued microtasks and awaited promises settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const navigateCommand = {
  kind: 'command',
  command: {
    id: 'cmd_1',
    sessionId: SESSION_ID,
    type: 'browser.navigate',
    payload: { url: 'https://app.test/orders' },
  },
};

describe('a command sent before the session lookup finishes', () => {
  it('is dispatched once the session is known, not dropped', async () => {
    const { connect, releaseLookup, dispatch } = gatewayWith();
    const socket = connect();

    // The client sends immediately — before the gateway knows the session.
    socket.emitMessage(navigateCommand);
    await settle();
    expect(dispatch).not.toHaveBeenCalled();

    releaseLookup();
    await settle();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ id: 'cmd_1', type: 'browser.navigate' });
  });

  it('answers it, so a waiting client is never left to time out', async () => {
    const { connect, releaseLookup } = gatewayWith();
    const socket = connect();

    socket.emitMessage(navigateCommand);
    releaseLookup();
    await settle();

    const results = socket.sent.filter(
      (frame) => (frame as { kind?: string }).kind === 'command-result',
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: { commandId: 'cmd_1', ok: true } });
  });

  it('preserves arrival order when several arrive during the lookup', async () => {
    const { connect, releaseLookup, dispatch } = gatewayWith();
    const socket = connect();

    for (const id of ['cmd_1', 'cmd_2', 'cmd_3']) {
      socket.emitMessage({ ...navigateCommand, command: { ...navigateCommand.command, id } });
    }
    releaseLookup();
    await settle();

    // Out-of-order execution would navigate somewhere the user did not ask for
    // last, which is worse than a refusal.
    expect(dispatch.mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual([
      'cmd_1',
      'cmd_2',
      'cmd_3',
    ]);
  });

  it('refuses a queued command when the session turns out not to exist', async () => {
    // The queue must not become a way to reach a capability for a session the
    // gateway already rejected.
    const { connect, releaseLookup, dispatch } = gatewayWith({
      session: err(RunnerErrors.liveSessionLost(SESSION_ID)),
    });
    const socket = connect();

    socket.emitMessage(navigateCommand);
    releaseLookup();
    await settle();

    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.sent).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'LIVE_SESSION_LOST' }),
    );
    expect(socket.closedWith).toBe(4404);
  });
});

describe('a command sent after the session is known', () => {
  it('is dispatched without being queued', async () => {
    const { connect, releaseLookup, dispatch } = gatewayWith();
    const socket = connect();

    releaseLookup();
    await settle();

    socket.emitMessage(navigateCommand);
    await settle();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('is rejected by the published schema before reaching a capability', async () => {
    const { connect, releaseLookup, dispatch } = gatewayWith();
    const socket = connect();
    releaseLookup();
    await settle();

    socket.emitMessage({
      kind: 'command',
      command: { id: 'cmd_x', sessionId: SESSION_ID, type: 'browser.eval', payload: {} },
    });
    await settle();

    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.sent).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'VALIDATION_FAILED' }),
    );
  });

  it('accepts auth.login, which names a profile and carries no credential', async () => {
    const { connect, releaseLookup, dispatch } = gatewayWith();
    const socket = connect();
    releaseLookup();
    await settle();

    socket.emitMessage({
      kind: 'command',
      command: {
        id: 'cmd_login',
        sessionId: SESSION_ID,
        type: 'auth.login',
        payload: { profileRef: 'MANAGER' },
      },
    });
    await settle();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
