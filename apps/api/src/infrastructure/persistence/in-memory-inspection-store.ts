import type { InspectionRecord, InspectionStorePort } from '@runner/application';
import type { InspectionStatus } from '@runner/test-ir-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';

/**
 * An in-memory InspectionStorePort.
 *
 * Exists so `pnpm dev` answers the inspection contract with nothing installed
 * but Node. Not for production: state is per-process and disappears on restart,
 * and a worker in another process cannot see it.
 */
export class InMemoryInspectionStore implements InspectionStorePort {
  private readonly records = new Map<string, InspectionRecord>();
  private readonly idempotencyKeys = new Map<string, string>();

  create(record: InspectionRecord): Promise<Result<InspectionRecord>> {
    if (this.records.has(record.inspectionId)) {
      return Promise.resolve(
        err(
          RunnerErrors.validationFailed(`Inspection "${record.inspectionId}" already exists.`, {
            inspectionId: record.inspectionId,
          }),
        ),
      );
    }
    this.records.set(record.inspectionId, record);
    return Promise.resolve(ok(record));
  }

  get(inspectionId: string): Promise<Result<InspectionRecord>> {
    const record = this.records.get(inspectionId);
    return Promise.resolve(
      record === undefined ? err(RunnerErrors.inspectionNotFound(inspectionId)) : ok(record),
    );
  }

  updateStatus(
    inspectionId: string,
    status: InspectionStatus,
    patch: Partial<
      Pick<InspectionRecord, 'startedAt' | 'completedAt' | 'error' | 'findings'>
    > = {},
  ): Promise<Result<InspectionRecord>> {
    const record = this.records.get(inspectionId);
    if (record === undefined) {
      return Promise.resolve(err(RunnerErrors.inspectionNotFound(inspectionId)));
    }

    const updated: InspectionRecord = { ...record, ...patch, status };
    this.records.set(inspectionId, updated);
    return Promise.resolve(ok(updated));
  }

  findByIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
  ): Promise<Result<InspectionRecord | undefined>> {
    const inspectionId = this.idempotencyKeys.get(scopedKey(workspaceRef, idempotencyKey));
    return Promise.resolve(
      ok(inspectionId === undefined ? undefined : this.records.get(inspectionId)),
    );
  }

  saveIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
    inspectionId: string,
  ): Promise<Result<void>> {
    this.idempotencyKeys.set(scopedKey(workspaceRef, idempotencyKey), inspectionId);
    return Promise.resolve(ok(undefined));
  }
}

/** Idempotency keys are scoped per workspace so tenants cannot collide. */
function scopedKey(workspaceRef: string, idempotencyKey: string): string {
  return `${workspaceRef}::${idempotencyKey}`;
}
