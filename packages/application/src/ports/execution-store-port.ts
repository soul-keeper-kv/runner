import type { ExecutionPlan, ExecutionTimelineItem } from '@runner/domain';
import type { ExecutionStatus } from '@runner/test-ir-model';
import type { Result } from '@runner/shared';

/**
 * Execution persistence.
 *
 * `irSnapshot` is stored verbatim (blueprint section 51): the Runner keeps an
 * immutable copy of what it was asked to run so a run stays reproducible and
 * auditable — while explicitly *not* becoming the system of record for
 * authored test cases.
 */

export interface ExecutionRecord {
  readonly executionId: string;
  readonly workspaceRef: string;
  readonly tenantRef?: string;
  readonly externalTestCaseRef?: string;
  readonly requestId?: string;
  readonly status: ExecutionStatus;
  readonly mode: 'AUTO' | 'REVIEW' | 'INTERACTIVE';
  readonly plan: ExecutionPlan;
  /** The exact submitted request, kept for audit and replay. */
  readonly irSnapshot: unknown;
  readonly timeline: readonly ExecutionTimelineItem[];
  readonly error?: unknown;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface ExecutionStorePort {
  create(record: ExecutionRecord): Promise<Result<ExecutionRecord>>;
  get(executionId: string): Promise<Result<ExecutionRecord>>;
  updateStatus(
    executionId: string,
    status: ExecutionStatus,
    patch?: Partial<Pick<ExecutionRecord, 'startedAt' | 'completedAt' | 'error'>>,
  ): Promise<Result<ExecutionRecord>>;
  upsertTimelineItem(
    executionId: string,
    item: ExecutionTimelineItem,
  ): Promise<Result<void>>;
  /** Supports the Idempotency-Key header on execution creation. */
  findByIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
  ): Promise<Result<ExecutionRecord | undefined>>;
  saveIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
    executionId: string,
  ): Promise<Result<void>>;
}
