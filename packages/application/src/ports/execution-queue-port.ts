import type { Result } from '@runner/shared';

/**
 * The API/worker seam (blueprint section 2.5).
 *
 * The API enqueues and returns 202; the worker consumes and drives Playwright.
 * They stay separate processes so a crashed browser never takes the public API
 * down with it. External services never see this queue — it is internal.
 */

export interface ExecutionJob {
  readonly executionId: string;
  readonly workspaceRef: string;
  readonly mode: 'AUTO' | 'REVIEW' | 'INTERACTIVE';
  readonly liveSessionId?: string;
  readonly enqueuedAt: string;
}

export interface EnqueueOptions {
  /** Higher runs first. Interactive work should outrank batch CI runs. */
  readonly priority?: number;
  readonly delayMs?: number;
  readonly attempts?: number;
}

export interface ExecutionQueuePort {
  enqueue(job: ExecutionJob, options?: EnqueueOptions): Promise<Result<void>>;
  /** Requests cancellation; a running job stops at its next checkpoint. */
  cancel(executionId: string): Promise<Result<void>>;
  close(): Promise<void>;
}
