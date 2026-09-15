import { type Redis } from 'ioredis';
import type { InspectionRecord, InspectionStorePort } from '@runner/application';
import type { InspectionStatus } from '@runner/test-ir-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';

/**
 * A Redis-backed InspectionStorePort shared by the API and the worker.
 *
 * The API writes a QUEUED record and enqueues; the worker reads it, inspects
 * the page and writes the findings back. Both processes see one state without
 * either importing the other's code.
 *
 * The TTL is much shorter than an execution's: an inspection describes a page
 * as it was at one moment, and a stale field list is worse than no field list,
 * so a caller is pushed toward submitting a fresh one.
 */

const KEY_PREFIX = 'runner:inspection:';
const IDEMPOTENCY_PREFIX = 'runner:inspection-idempotency:';
const RECORD_TTL_SECONDS = 6 * 3600;

export class RedisInspectionStore implements InspectionStorePort {
  constructor(private readonly redis: Redis) {}

  async create(record: InspectionRecord): Promise<Result<InspectionRecord>> {
    try {
      // NX so a duplicate id can never overwrite an in-flight inspection.
      const written = await this.redis.set(
        key(record.inspectionId),
        JSON.stringify(record),
        'EX',
        RECORD_TTL_SECONDS,
        'NX',
      );

      if (written === null) {
        return err(
          RunnerErrors.validationFailed(`Inspection "${record.inspectionId}" already exists.`, {
            inspectionId: record.inspectionId,
          }),
        );
      }
      return ok(record);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not persist the inspection record.', cause));
    }
  }

  async get(inspectionId: string): Promise<Result<InspectionRecord>> {
    try {
      const raw = await this.redis.get(key(inspectionId));
      if (raw === null) return err(RunnerErrors.inspectionNotFound(inspectionId));
      return ok(JSON.parse(raw) as InspectionRecord);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the inspection record.', cause));
    }
  }

  async updateStatus(
    inspectionId: string,
    status: InspectionStatus,
    patch: Partial<
      Pick<InspectionRecord, 'startedAt' | 'completedAt' | 'error' | 'findings'>
    > = {},
  ): Promise<Result<InspectionRecord>> {
    const existing = await this.get(inspectionId);
    if (!existing.ok) return existing;

    const updated: InspectionRecord = { ...existing.value, ...patch, status };
    try {
      await this.redis.set(
        key(inspectionId),
        JSON.stringify(updated),
        'EX',
        RECORD_TTL_SECONDS,
      );
      return ok(updated);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not update the inspection record.', cause));
    }
  }

  async findByIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
  ): Promise<Result<InspectionRecord | undefined>> {
    try {
      const inspectionId = await this.redis.get(idempotencyKeyOf(workspaceRef, idempotencyKey));
      if (inspectionId === null) return ok(undefined);

      const record = await this.get(inspectionId);
      // An expired record behind a live key means a fresh inspection, not a 500.
      return record.ok ? ok(record.value) : ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the idempotency key.', cause));
    }
  }

  async saveIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
    inspectionId: string,
  ): Promise<Result<void>> {
    try {
      await this.redis.set(
        idempotencyKeyOf(workspaceRef, idempotencyKey),
        inspectionId,
        'EX',
        RECORD_TTL_SECONDS,
      );
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not persist the idempotency key.', cause));
    }
  }
}

function key(inspectionId: string): string {
  return `${KEY_PREFIX}${inspectionId}`;
}

/** Idempotency keys are scoped per workspace so tenants cannot collide. */
function idempotencyKeyOf(workspaceRef: string, idempotencyKey: string): string {
  return `${IDEMPOTENCY_PREFIX}${workspaceRef}:${idempotencyKey}`;
}
