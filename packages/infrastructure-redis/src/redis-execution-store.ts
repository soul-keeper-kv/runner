import { type Redis } from 'ioredis';
import type { ExecutionRecord, ExecutionStorePort } from '@runner/application';
import type { ExecutionTimelineItem } from '@runner/domain';
import type { ExecutionStatus } from '@runner/test-ir-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';

/**
 * A Redis-backed ExecutionStorePort shared by the API and the worker.
 *
 * The API writes a record when it accepts a run; the worker reads it, drives
 * the browser, and writes each timeline item back as the run progresses. Both
 * processes therefore see one execution state without either importing the
 * other's code.
 *
 * Postgres replaces this in Phase 1+ for durability, reporting and retention
 * (blueprint section 51). Redis is chosen here because it is already required
 * for the queue: it keeps the number of moving parts a developer needs running
 * to one, and it satisfies the same port, so the swap touches only the
 * composition root.
 */

const KEY_PREFIX = 'runner:execution:';
const IDEMPOTENCY_PREFIX = 'runner:idempotency:';
/** Executions outlive a run but are not a system of record; expire them. */
const RECORD_TTL_SECONDS = 7 * 24 * 3600;

export class RedisExecutionStore implements ExecutionStorePort {
  constructor(private readonly redis: Redis) {}

  async create(record: ExecutionRecord): Promise<Result<ExecutionRecord>> {
    try {
      // NX so a duplicate execution id can never overwrite an existing run.
      const written = await this.redis.set(
        key(record.executionId),
        JSON.stringify(record),
        'EX',
        RECORD_TTL_SECONDS,
        'NX',
      );

      if (written === null) {
        return err(
          RunnerErrors.validationFailed(`Execution "${record.executionId}" already exists.`, {
            executionId: record.executionId,
          }),
        );
      }
      return ok(record);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not persist the execution record.', cause));
    }
  }

  async get(executionId: string): Promise<Result<ExecutionRecord>> {
    try {
      const raw = await this.redis.get(key(executionId));
      if (raw === null) return err(RunnerErrors.executionNotFound(executionId));
      return ok(JSON.parse(raw) as ExecutionRecord);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the execution record.', cause));
    }
  }

  async updateStatus(
    executionId: string,
    status: ExecutionStatus,
    patch: Partial<Pick<ExecutionRecord, 'startedAt' | 'completedAt' | 'error'>> = {},
  ): Promise<Result<ExecutionRecord>> {
    const existing = await this.get(executionId);
    if (!existing.ok) return existing;

    const updated: ExecutionRecord = { ...existing.value, ...patch, status };
    return this.write(updated);
  }

  async upsertTimelineItem(
    executionId: string,
    item: ExecutionTimelineItem,
  ): Promise<Result<void>> {
    const existing = await this.get(executionId);
    if (!existing.ok) return existing;

    const timeline = [...existing.value.timeline];
    const index = timeline.findIndex((entry) => entry.stepId === item.stepId);
    if (index >= 0) timeline[index] = item;
    else timeline.push(item);

    const written = await this.write({ ...existing.value, timeline });
    return written.ok ? ok(undefined) : written;
  }

  async findByIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
  ): Promise<Result<ExecutionRecord | undefined>> {
    try {
      const executionId = await this.redis.get(idempotencyKeyOf(workspaceRef, idempotencyKey));
      if (executionId === null) return ok(undefined);

      const record = await this.get(executionId);
      // A mapped key whose execution has expired is treated as absent rather
      // than as an error: the caller should get a fresh run, not a 500.
      return record.ok ? ok(record.value) : ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the idempotency key.', cause));
    }
  }

  async saveIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
    executionId: string,
  ): Promise<Result<void>> {
    try {
      await this.redis.set(
        idempotencyKeyOf(workspaceRef, idempotencyKey),
        executionId,
        'EX',
        RECORD_TTL_SECONDS,
      );
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not persist the idempotency key.', cause));
    }
  }

  private async write(record: ExecutionRecord): Promise<Result<ExecutionRecord>> {
    try {
      await this.redis.set(
        key(record.executionId),
        JSON.stringify(record),
        'EX',
        RECORD_TTL_SECONDS,
      );
      return ok(record);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not update the execution record.', cause));
    }
  }
}

function key(executionId: string): string {
  return `${KEY_PREFIX}${executionId}`;
}

/** Idempotency keys are scoped per workspace so tenants cannot collide. */
function idempotencyKeyOf(workspaceRef: string, idempotencyKey: string): string {
  return `${IDEMPOTENCY_PREFIX}${workspaceRef}:${idempotencyKey}`;
}
