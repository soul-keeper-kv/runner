import type {
  InspectionEnqueueOptions,
  InspectionJob,
  InspectionQueuePort,
} from '@runner/application';
import { ok, type Logger, type Result } from '@runner/shared';

/**
 * An in-memory InspectionQueuePort used when Redis is not configured.
 *
 * It records jobs but runs nothing: an inspection submitted against it stays
 * QUEUED forever. Deliberately honest — the contract can be exercised while the
 * absence of a worker stays visible rather than being faked with a result.
 */
export class InMemoryInspectionQueue implements InspectionQueuePort {
  private readonly jobs = new Map<string, InspectionJob>();

  constructor(private readonly logger: Logger) {}

  enqueue(job: InspectionJob, _options?: InspectionEnqueueOptions): Promise<Result<void>> {
    this.jobs.set(job.inspectionId, job);
    this.logger.warn(
      'Inspection accepted by the in-memory queue; no worker will pick it up. Configure REDIS_URL and start apps/worker.',
      { inspectionId: job.inspectionId },
    );
    return Promise.resolve(ok(undefined));
  }

  close(): Promise<void> {
    this.jobs.clear();
    return Promise.resolve();
  }

  /** Test helper: the jobs that were enqueued. */
  pending(): readonly InspectionJob[] {
    return [...this.jobs.values()];
  }
}
