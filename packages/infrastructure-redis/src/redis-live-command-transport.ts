import { Redis } from 'ioredis';
import type {
  LiveCommandDispatchOptions,
  LiveCommandHandler,
  LiveCommandTransportPort,
} from '@runner/application';
import type { LiveCommandResult, RawLiveCommand } from '@runner/live-protocol';
import { RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';

/**
 * Request/reply over Redis lists, carrying live commands from the API to the
 * worker that owns the browser.
 *
 * Why lists rather than BullMQ, which this repository already uses: a live
 * command is interactive request/reply with a short deadline, not a durable job.
 * BullMQ's retries, backoff and persistence are exactly wrong here — a retried
 * `browser.navigate` would navigate twice, and a command whose user has walked
 * away should expire, not sit in a queue.
 *
 * Why Redis rather than HTTP between the two processes: Redis is already a hard
 * dependency for the queue, so this adds no new moving part to run, and the
 * worker stays unaddressable from outside — nothing but the API can reach it,
 * which keeps the public surface exactly one process wide.
 *
 * The shape is the standard blocking-list RPC:
 *
 *   API    → RPUSH runner:live:commands  {command, replyTo}
 *   worker → BLPOP runner:live:commands, handles it
 *   worker → RPUSH runner:live:reply:<commandId> {result}
 *   API    → BLPOP runner:live:reply:<commandId>
 *
 * Each reply key is per-command and expires, so a caller that has already timed
 * out cannot receive another command's answer, and an abandoned reply cannot
 * leak memory in Redis.
 */

const COMMAND_QUEUE_KEY = 'runner:live:commands';
const REPLY_KEY_PREFIX = 'runner:live:reply:';

/** Long enough for a slow page, short enough that a user is not left hanging. */
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * A reply nobody is waiting for is deleted rather than kept: the dispatcher has
 * already failed the command, so the payload is only clutter.
 */
const REPLY_TTL_SECONDS = 60;

interface TransportEnvelope {
  readonly command: RawLiveCommand;
  readonly replyTo: string;
  readonly expiresAtMs: number;
}

export class RedisLiveCommandTransport implements LiveCommandTransportPort {
  /**
   * Blocking reads need their own connections: a BLPOP occupies a connection
   * for its whole timeout, and sharing one with ordinary commands would stall
   * every other operation on it.
   */
  private readonly commands: Redis;
  private readonly replies: Redis;
  private serving = false;
  private closed = false;

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
  ) {
    this.commands = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.replies = new Redis(redisUrl, { maxRetriesPerRequest: null });
  }

  async dispatch(
    command: RawLiveCommand,
    options: LiveCommandDispatchOptions = {},
  ): Promise<Result<LiveCommandResult>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const replyTo = `${REPLY_KEY_PREFIX}${command.id}`;

    const envelope: TransportEnvelope = {
      command,
      replyTo,
      expiresAtMs: Date.now() + timeoutMs,
    };

    try {
      await this.commands.rpush(COMMAND_QUEUE_KEY, JSON.stringify(envelope));

      // BLPOP takes whole seconds and 0 means "block forever", so a sub-second
      // deadline must still round up to 1 rather than hang indefinitely.
      const blockSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const answer = await this.replies.blpop(replyTo, blockSeconds);

      if (answer === null) {
        // Nobody answered. Drop the reply key so a late worker's write does not
        // linger for a caller that has already given up.
        await this.replies.del(replyTo).catch(() => undefined);
        return err(
          RunnerErrors.internal(
            `No worker answered live command "${command.type}" within ${timeoutMs}ms. Is the worker running?`,
          ),
        );
      }

      const [, raw] = answer;
      return ok(JSON.parse(raw) as LiveCommandResult);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not dispatch the live command.', cause));
    }
  }

  async serve(handler: LiveCommandHandler): Promise<Result<void>> {
    if (this.serving) {
      // Two serve loops on one transport would race for the same commands and
      // each get an arbitrary half. That is a wiring bug, not a runtime state.
      return err(RunnerErrors.internal('This transport is already serving live commands.'));
    }
    this.serving = true;

    void this.serveLoop(handler);
    this.logger.info('Live command transport serving', { queue: COMMAND_QUEUE_KEY });
    return ok(undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.commands.disconnect();
    this.replies.disconnect();
  }

  /**
   * Consumes commands until closed.
   *
   * Every outcome is answered, including a handler that throws: a client
   * waiting on a reply must never be left to time out over a bug it cannot see.
   */
  private async serveLoop(handler: LiveCommandHandler): Promise<void> {
    while (!this.closed) {
      let envelope: TransportEnvelope | undefined;

      try {
        // One second, so closing the worker is responsive rather than waiting
        // out a long block.
        const next = await this.commands.blpop(COMMAND_QUEUE_KEY, 1);
        if (next === null) continue;

        const [, raw] = next;
        envelope = JSON.parse(raw) as TransportEnvelope;
      } catch (cause) {
        if (this.closed) return;
        this.logger.error('Live command transport read failed', {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }

      // The dispatcher has already given up; running the command would drive a
      // browser for a result nobody will read.
      if (envelope.expiresAtMs < Date.now()) {
        this.logger.warn('Discarding an expired live command', {
          commandType: envelope.command.type,
          sessionId: envelope.command.sessionId,
        });
        continue;
      }

      await this.handleOne(handler, envelope);
    }
  }

  private async handleOne(
    handler: LiveCommandHandler,
    envelope: TransportEnvelope,
  ): Promise<void> {
    const { command, replyTo } = envelope;
    let result: LiveCommandResult;

    try {
      result = await handler(command);
    } catch (cause) {
      // A throw from a capability is a programmer error, but the client still
      // gets a structured answer rather than silence.
      this.logger.error('Live command handler threw', {
        commandType: command.type,
        sessionId: command.sessionId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      result = {
        commandId: command.id,
        sessionId: command.sessionId,
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The live command handler failed unexpectedly.',
        },
        completedAt: new Date().toISOString(),
        revision: 0,
      };
    }

    try {
      await this.commands
        .multi()
        .rpush(replyTo, JSON.stringify(result))
        .expire(replyTo, REPLY_TTL_SECONDS)
        .exec();
    } catch (cause) {
      this.logger.error('Could not publish a live command result', {
        commandType: command.type,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
