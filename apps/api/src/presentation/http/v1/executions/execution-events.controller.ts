import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { getExecution } from '@runner/application';
import { isTerminalStatus } from '@runner/test-ir-model';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

/**
 * Server-Sent Events for execution progress (blueprint section 52.5).
 *
 * The third of the three supported consumption styles, alongside polling and
 * webhooks. SSE rather than WebSocket here because this stream is one-way and
 * read-only — a plain HTTP client can consume it, which keeps the barrier to
 * integration low.
 *
 * This implementation polls the execution store. That is honest for the current
 * phase: it delivers correct events with no Redis pub/sub, and swapping to a
 * pushed event bus later changes nothing for consumers.
 */
@Controller('api/v1/executions')
export class ExecutionEventsController {
  private static readonly POLL_INTERVAL_MS = 1000;
  private static readonly MAX_STREAM_MS = 10 * 60 * 1000;

  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  @Get(':executionId/events')
  async events(
    @Param('executionId') executionId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const initial = await getExecution({ store: this.container.executionStore }, executionId);
    if (!initial.ok) throw initial.error;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let sequence = 0;
    let lastSerialized = '';
    const startedAt = Date.now();

    const send = (type: string, payload: unknown): void => {
      sequence += 1;
      reply.raw.write(`event: ${type}\n`);
      reply.raw.write(
        `data: ${JSON.stringify({ type, executionId, sequence, timestamp: this.container.clock.nowIso(), payload })}\n\n`,
      );
    };

    send('execution.snapshot', initial.value);
    lastSerialized = JSON.stringify(initial.value);

    const finish = (): void => {
      clearInterval(timer);
      reply.raw.end();
    };

    const timer = setInterval(() => {
      void (async () => {
        // A stream must not outlive its usefulness; a client that wants more
        // reconnects, which also re-sends a fresh snapshot.
        if (Date.now() - startedAt > ExecutionEventsController.MAX_STREAM_MS) {
          send('execution.stream.timeout', { reason: 'Maximum stream duration reached.' });
          finish();
          return;
        }

        const current = await getExecution({ store: this.container.executionStore }, executionId);
        if (!current.ok) {
          send('execution.failed', { error: current.error.toJSON() });
          finish();
          return;
        }

        const serialized = JSON.stringify(current.value);
        if (serialized !== lastSerialized) {
          lastSerialized = serialized;
          send('execution.updated', current.value);
        }

        if (isTerminalStatus(current.value.status)) {
          send(`execution.${current.value.status.toLowerCase()}`, current.value);
          finish();
        }
      })();
    }, ExecutionEventsController.POLL_INTERVAL_MS);

    reply.raw.on('close', () => clearInterval(timer));
  }
}
