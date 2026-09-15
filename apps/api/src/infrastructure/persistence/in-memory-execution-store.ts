import type { ExecutionRecord, ExecutionStorePort } from '@runner/application';
import type { ExecutionTimelineItem } from '@runner/domain';
import type { ExecutionStatus } from '@runner/test-ir-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';

/**
 * An in-memory ExecutionStorePort.
 *
 * Its purpose is that `pnpm dev` works with nothing installed but Node: the API
 * boots, accepts an execution and answers a status poll, so the contract can be
 * exercised before Docker is running. Postgres replaces it by swapping the
 * binding in the composition root — no call site changes.
 *
 * Not for production: state is per-process and disappears on restart.
 */
export class InMemoryExecutionStore implements ExecutionStorePort {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly idempotencyKeys = new Map<string, string>();

  create(record: ExecutionRecord): Promise<Result<ExecutionRecord>> {
    if (this.records.has(record.executionId)) {
      return Promise.resolve(
        err(
          RunnerErrors.validationFailed(`Execution "${record.executionId}" already exists.`, {
            executionId: record.executionId,
          }),
        ),
      );
    }
    this.records.set(record.executionId, record);
    return Promise.resolve(ok(record));
  }

  get(executionId: string): Promise<Result<ExecutionRecord>> {
    const record = this.records.get(executionId);
    return Promise.resolve(
      record === undefined ? err(RunnerErrors.executionNotFound(executionId)) : ok(record),
    );
  }

  updateStatus(
    executionId: string,
    status: ExecutionStatus,
    patch: Partial<Pick<ExecutionRecord, 'startedAt' | 'completedAt' | 'error'>> = {},
  ): Promise<Result<ExecutionRecord>> {
    const record = this.records.get(executionId);
    if (record === undefined) {
      return Promise.resolve(err(RunnerErrors.executionNotFound(executionId)));
    }

    const updated: ExecutionRecord = { ...record, ...patch, status };
    this.records.set(executionId, updated);
    return Promise.resolve(ok(updated));
  }

  upsertTimelineItem(executionId: string, item: ExecutionTimelineItem): Promise<Result<void>> {
    const record = this.records.get(executionId);
    if (record === undefined) {
      return Promise.resolve(err(RunnerErrors.executionNotFound(executionId)));
    }

    const timeline = [...record.timeline];
    const index = timeline.findIndex((existing) => existing.stepId === item.stepId);
    if (index >= 0) timeline[index] = item;
    else timeline.push(item);

    this.records.set(executionId, { ...record, timeline });
    return Promise.resolve(ok(undefined));
  }

  findByIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
  ): Promise<Result<ExecutionRecord | undefined>> {
    const executionId = this.idempotencyKeys.get(scopedKey(workspaceRef, idempotencyKey));
    return Promise.resolve(
      ok(executionId === undefined ? undefined : this.records.get(executionId)),
    );
  }

  saveIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
    executionId: string,
  ): Promise<Result<void>> {
    this.idempotencyKeys.set(scopedKey(workspaceRef, idempotencyKey), executionId);
    return Promise.resolve(ok(undefined));
  }
}

/** Idempotency keys are scoped per workspace so tenants cannot collide. */
function scopedKey(workspaceRef: string, idempotencyKey: string): string {
  return `${workspaceRef}::${idempotencyKey}`;
}
