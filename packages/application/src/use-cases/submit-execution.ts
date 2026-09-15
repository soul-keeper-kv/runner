import type { ExecutionRequestV1, ExecutionAcceptedV1 } from '@runner/test-ir-model';
import { err, newExecutionId, ok, type Clock, type Logger, type Result } from '@runner/shared';
import type { ExecutionQueuePort } from '../ports/execution-queue-port.js';
import type { ExecutionRecord, ExecutionStorePort } from '../ports/execution-store-port.js';
import { mapExecutionRequest } from '../mappers/inbound-test-action-mapper.js';
import { pendingItem } from '@runner/domain';

/**
 * Accepts an execution request and hands it to the queue (blueprint 52.1).
 *
 * This use case deliberately does no browser work. It validates, persists an
 * immutable snapshot of what was submitted, enqueues, and returns 202 — so a
 * slow or crashed browser can never make the public API slow or unavailable.
 */

export interface SubmitExecutionDeps {
  readonly store: ExecutionStorePort;
  readonly queue: ExecutionQueuePort;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface SubmitExecutionInput {
  readonly request: ExecutionRequestV1;
  /** From the Idempotency-Key header; retries must not start a second run. */
  readonly idempotencyKey?: string;
  readonly liveSessionId?: string;
}

export async function submitExecution(
  deps: SubmitExecutionDeps,
  input: SubmitExecutionInput,
): Promise<Result<ExecutionAcceptedV1>> {
  const { store, queue, clock, logger } = deps;
  const { request, idempotencyKey } = input;

  // An idempotent retry returns the original acceptance rather than a new run.
  if (idempotencyKey !== undefined && request.workspaceRef !== undefined) {
    const existing = await store.findByIdempotencyKey(request.workspaceRef, idempotencyKey);
    if (existing.ok && existing.value !== undefined) {
      logger.info('Returning existing execution for idempotency key', {
        runId: existing.value.executionId,
        idempotencyKey,
      });
      return ok(toAccepted(existing.value));
    }
  }

  const executionId = newExecutionId();
  const planned = mapExecutionRequest({ request, executionId });
  if (!planned.ok) {
    logger.warn('Rejected execution request', {
      errorCode: planned.error.code,
      requestId: request.requestId,
    });
    return planned;
  }

  const plan = planned.value;
  const queuedAt = clock.nowIso();

  const record: ExecutionRecord = {
    executionId,
    workspaceRef: plan.workspaceRef,
    ...(plan.tenantRef === undefined ? {} : { tenantRef: plan.tenantRef }),
    ...(plan.externalTestCaseRef === undefined
      ? {}
      : { externalTestCaseRef: plan.externalTestCaseRef }),
    ...(plan.requestId === undefined ? {} : { requestId: plan.requestId }),
    status: 'QUEUED',
    mode: plan.mode,
    plan,
    // Stored verbatim so the run stays reproducible and auditable (section 51).
    irSnapshot: request,
    timeline: plan.actions.map((action) => pendingItem(action.id, action.type, action.label)),
    queuedAt,
  };

  const created = await store.create(record);
  if (!created.ok) return created;

  if (idempotencyKey !== undefined) {
    const saved = await store.saveIdempotencyKey(plan.workspaceRef, idempotencyKey, executionId);
    if (!saved.ok) {
      logger.warn('Could not persist idempotency key', {
        runId: executionId,
        errorCode: saved.error.code,
      });
    }
  }

  const enqueued = await queue.enqueue({
    executionId,
    workspaceRef: plan.workspaceRef,
    mode: plan.mode,
    ...(input.liveSessionId === undefined ? {} : { liveSessionId: input.liveSessionId }),
    enqueuedAt: queuedAt,
  });

  if (!enqueued.ok) {
    // The record stays FAILED rather than QUEUED, so a run that no worker will
    // ever pick up is visible instead of appearing to hang forever.
    await store.updateStatus(executionId, 'FAILED', {
      completedAt: clock.nowIso(),
      error: enqueued.error.toJSON(),
    });
    return err(enqueued.error);
  }

  logger.info('Execution queued', {
    runId: executionId,
    requestId: plan.requestId,
    stepCount: plan.actions.length,
  });

  return ok(toAccepted(created.value));
}

function toAccepted(record: ExecutionRecord): ExecutionAcceptedV1 {
  const accepted: Record<string, unknown> = {
    executionId: record.executionId,
    status: record.status,
    statusUrl: `/api/v1/executions/${record.executionId}`,
    eventsUrl: `/api/v1/executions/${record.executionId}/events`,
    acceptedAt: record.queuedAt,
  };
  if (record.requestId !== undefined) accepted.requestId = record.requestId;
  return accepted as unknown as ExecutionAcceptedV1;
}
