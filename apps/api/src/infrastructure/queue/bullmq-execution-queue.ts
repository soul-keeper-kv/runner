import { Queue } from 'bullmq';
import type { EnqueueOptions, ExecutionJob, ExecutionQueuePort } from '@runner/application';
import { RunnerError, err, ok, type Logger, type Result } from '@runner/shared';

/**
 * The BullMQ-backed ExecutionQueuePort.
 *
 * This queue is strictly internal (blueprint section 2.5). No external service
 * may publish to it — they call POST /api/v1/executions, and the API decides
 * what gets enqueued. That indirection is what lets the Runner validate,
 * authorize and record a run before any browser work is scheduled.
 */

export const EXECUTION_QUEUE_NAME = 'runner.executions';

export class BullMqExecutionQueue implements ExecutionQueuePort {
  private readonly queue: Queue<ExecutionJob>;

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
  ) {
    this.queue = new Queue<ExecutionJob>(EXECUTION_QUEUE_NAME, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 1,
        // Keep a short history for debugging without letting Redis grow forever.
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  }

  async enqueue(job: ExecutionJob, options: EnqueueOptions = {}): Promise<Result<void>> {
    try {
      await this.queue.add(job.executionId, job, {
        jobId: job.executionId,
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
        ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
      });
      this.logger.debug('Execution enqueued', { runId: job.executionId });
      return ok(undefined);
    } catch (cause) {
      return err(
        new RunnerError('INTERNAL_ERROR', 'Could not enqueue the execution job.', {
          cause,
          details: { executionId: job.executionId },
          retryable: true,
        }),
      );
    }
  }

  async cancel(executionId: string): Promise<Result<void>> {
    try {
      const job = await this.queue.getJob(executionId);
      // A job already picked up by a worker cannot be removed; the worker sees
      // the CANCELLED status and stops at its next step boundary.
      if (job !== undefined && (await job.isWaiting())) {
        await job.remove();
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new RunnerError('INTERNAL_ERROR', 'Could not cancel the execution job.', {
          cause,
          details: { executionId },
        }),
      );
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
