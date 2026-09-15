import type { EnqueueOptions, ExecutionJob, ExecutionQueuePort } from '@runner/application';
import { ok, type Logger, type Result } from '@runner/shared';

/**
 * An in-memory ExecutionQueuePort used when Redis is not configured.
 *
 * It records jobs but runs nothing: an execution submitted against it stays
 * QUEUED forever. That is deliberate and honest — the API contract can be
 * exercised end to end, while the absence of a worker stays visible rather than
 * being faked with a synthetic result.
 */
export class InMemoryExecutionQueue implements ExecutionQueuePort {
  private readonly jobs = new Map<string, ExecutionJob>();

  constructor(private readonly logger: Logger) {}

  enqueue(job: ExecutionJob, _options?: EnqueueOptions): Promise<Result<void>> {
    this.jobs.set(job.executionId, job);
    this.logger.warn(
      'Execution accepted by the in-memory queue; no worker will pick it up. Configure REDIS_URL and start apps/worker.',
      { runId: job.executionId },
    );
    return Promise.resolve(ok(undefined));
  }

  cancel(executionId: string): Promise<Result<void>> {
    this.jobs.delete(executionId);
    return Promise.resolve(ok(undefined));
  }

  close(): Promise<void> {
    this.jobs.clear();
    return Promise.resolve();
  }

  /** Test helper: the jobs that were enqueued. */
  pending(): readonly ExecutionJob[] {
    return [...this.jobs.values()];
  }
}
