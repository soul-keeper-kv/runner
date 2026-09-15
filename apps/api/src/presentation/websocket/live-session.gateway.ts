import type { FastifyInstance } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import { getLiveSession } from '@runner/application';
import { SCHEMA_IDS } from '@runner/contracts-internal';
import type { LiveServerMessage, RawLiveCommand } from '@runner/live-protocol';
import { type RunnerError, RunnerErrors, newEventId } from '@runner/shared';
import type { ApiContainer } from '../../infrastructure/container.js';

/**
 * The live session WebSocket (blueprint sections 27 and 52.4).
 *
 * This gateway is a *transport*, not a place where browser work happens. It
 * validates each incoming frame against the published live-command schema and
 * forwards it to a capability handler in the worker. Keeping it this thin is
 * what stops the socket layer from quietly growing Playwright knowledge, which
 * blueprint section 3.1 forbids.
 *
 * The worker's result is relayed verbatim. A command that reached a capability
 * and failed there is still a successful round trip — the failure is the
 * answer, and the client renders it — so only an undeliverable command becomes
 * an error frame.
 */
export function registerLiveSessionGateway(app: FastifyInstance, container: ApiContainer): void {
  app.get<{ Params: { sessionId: string } }>(
    '/api/v1/live-sessions/:sessionId/ws',
    { websocket: true },
    (connection: SocketStream, request) => {
      const socket = connection.socket;
      const { sessionId } = request.params;
      const logger = container.logger.child({ sessionId });

      /*
       * The message listener is attached synchronously, before the session
       * lookup below, and frames that arrive during it are queued.
       *
       * Attaching it after the `await` loses whatever was sent in the meantime:
       * `ws` discards a message with no listener, so the command vanished with
       * no error, no log and no reply, and the client waited out its timeout.
       * A client that sends as soon as the socket opens wins that race almost
       * every time against a warm server — which made the first command of
       * every session after the first one disappear.
       */
      let ready = false;
      const queued: Buffer[] = [];

      socket.on('message', (raw: Buffer) => {
        if (!ready) {
          queued.push(raw);
          return;
        }
        void handleMessage(socket, container, sessionId, raw);
      });

      socket.on('close', () => {
        logger.info('Live session socket disconnected');
      });

      void (async () => {
        const session = await getLiveSession(
          { sessions: container.sessionStore, clock: container.clock, logger: container.logger },
          sessionId,
        );

        if (!session.ok) {
          send(socket, {
            kind: 'error',
            code: session.error.code,
            message: session.error.message,
          });
          socket.close(4404, 'Live session not found');
          return;
        }

        logger.info('Live session socket connected');

        send(socket, {
          kind: 'event',
          event: {
            id: newEventId(),
            sessionId,
            type: 'session.state.changed',
            sequence: 0,
            timestamp: container.clock.nowIso(),
            payload: session.value,
          },
        });

        // Drained in arrival order, and only now that the session is known to
        // exist: a command for a session that was never found must be refused
        // rather than dispatched.
        ready = true;
        for (const raw of queued) {
          await handleMessage(socket, container, sessionId, raw);
        }
        queued.length = 0;
      })();
    },
  );
}

async function handleMessage(
  socket: SocketStream['socket'],
  container: ApiContainer,
  sessionId: string,
  raw: Buffer,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    send(socket, {
      kind: 'error',
      code: 'VALIDATION_FAILED',
      message: 'Message is not valid JSON.',
    });
    return;
  }

  const envelope = parsed as { kind?: string; command?: unknown };

  if (envelope.kind === 'ping') {
    send(socket, {
      kind: 'event',
      event: {
        id: newEventId(),
        sessionId,
        type: 'session.state.changed',
        sequence: 0,
        timestamp: container.clock.nowIso(),
        payload: { pong: true },
      },
    });
    return;
  }

  if (envelope.kind !== 'command') {
    send(socket, {
      kind: 'error',
      code: 'VALIDATION_FAILED',
      message: 'Expected a message of kind "command" or "ping".',
    });
    return;
  }

  // Validated against the same published schema an external client would use,
  // so the socket cannot accept a command the contract rejects.
  const validated = container.schemas.validate(SCHEMA_IDS.liveCommand, envelope.command);
  if (!validated.ok) {
    send(socket, {
      kind: 'error',
      code: validated.error.code,
      message: validated.error.message,
    });
    return;
  }

  const command = envelope.command as RawLiveCommand;

  // Keep the socket honest about the session it belongs to.
  if (command.sessionId !== sessionId) {
    send(socket, {
      kind: 'error',
      code: 'VALIDATION_FAILED',
      message: 'Command sessionId does not match the socket session.',
    });
    return;
  }

  const touched = await container.sessionStore.touch(sessionId);
  if (!touched.ok) {
    send(socket, {
      kind: 'error',
      code: touched.error.code,
      message: touched.error.message,
    });
    return;
  }

  // No transport means no worker to dispatch to. Saying so beats waiting out a
  // timeout against a process that was never configured.
  if (container.liveCommands === undefined) {
    const error: RunnerError = RunnerErrors.capabilityNotImplemented(
      'Live command dispatch (requires REDIS_URL and a running worker)',
    );
    send(socket, {
      kind: 'command-result',
      result: {
        commandId: command.id,
        sessionId,
        ok: false,
        error: { code: error.code, message: error.message, details: { commandType: command.type } },
        completedAt: container.clock.nowIso(),
        revision: 0,
      },
    });
    return;
  }

  const dispatched = await container.liveCommands.dispatch(command);

  if (!dispatched.ok) {
    // The command never reached a capability: undeliverable, or the worker did
    // not answer in time.
    send(socket, {
      kind: 'command-result',
      result: {
        commandId: command.id,
        sessionId,
        ok: false,
        error: {
          code: dispatched.error.code,
          message: dispatched.error.message,
          details: { commandType: command.type },
        },
        completedAt: container.clock.nowIso(),
        revision: 0,
      },
    });
    return;
  }

  send(socket, { kind: 'command-result', result: dispatched.value });
}

function send(socket: SocketStream['socket'], message: LiveServerMessage): void {
  socket.send(JSON.stringify(message));
}
