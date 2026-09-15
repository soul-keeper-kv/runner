import { Queue } from 'bullmq';
import type {
  InspectionEnqueueOptions,
  InspectionJob,
  InspectionQueuePort,
} from '@runner/application';
import { RunnerError, err, ok, type Logger, type Result } from '@runner/shared';

/**
 * The BullMQ-backed InspectionQueuePort.
 *
 * Strictly internal, like the execution queue: no external service publishes to
 * it. Callers POST /api/v1/inspections and the API decides what is enqueued,
 * which is what lets the Runner validate and record a request before any
 * browser work is scheduled.
 */

export const INSPECTION_QUEUE_NAME = 'runner.inspections';

export class BullMqInspectionQueue implements InspectionQueuePort {
  private readonly queue: Queue<InspectionJob>;

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
  ) {
    this.queue = new Queue<InspectionJob>(INSPECTION_QUEUE_NAME, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        // One attempt: a page that failed to load will fail again, and a caller
        // waiting on a field list is better served by a prompt error.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  }

  async enqueue(
    job: InspectionJob,
    options: InspectionEnqueueOptions = {},
  ): Promise<Result<void>> {
    try {
      await this.queue.add(job.inspectionId, job, {
        jobId: job.inspectionId,
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
      });
      this.logger.debug('Inspection enqueued', { inspectionId: job.inspectionId });
      return ok(undefined);
    } catch (cause) {
      return err(
        new RunnerError('INTERNAL_ERROR', 'Could not enqueue the inspection job.', {
          cause,
          details: { inspectionId: job.inspectionId },
          retryable: true,
        }),
      );
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
