import type { Result } from '@runner/shared';

/**
 * The API/worker seam for page inspection.
 *
 * A separate queue from executions rather than a second job type on one queue:
 * an inspection is short and latency-sensitive, while a test run can occupy a
 * browser for minutes. Keeping them apart means a queue of slow regression runs
 * cannot delay the inspection a user is waiting on, and the two can be given
 * different worker concurrency.
 */

export interface InspectionJob {
  readonly inspectionId: string;
  readonly workspaceRef: string;
  readonly enqueuedAt: string;
}

export interface InspectionEnqueueOptions {
  readonly priority?: number;
  readonly attempts?: number;
}

export interface InspectionQueuePort {
  enqueue(job: InspectionJob, options?: InspectionEnqueueOptions): Promise<Result<void>>;
  close(): Promise<void>;
}
