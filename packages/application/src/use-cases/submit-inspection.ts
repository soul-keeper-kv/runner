import {
  INSPECTION_CONTRACT_VERSION,
  type InspectionAcceptedV1,
  type InspectionRequestV1,
} from '@runner/test-ir-model';
import {
  RunnerErrors,
  err,
  newInspectionId,
  ok,
  type Clock,
  type Logger,
  type Result,
} from '@runner/shared';
import type { InspectionQueuePort } from '../ports/inspection-queue-port.js';
import type { InspectionRecord, InspectionStorePort } from '../ports/inspection-store-port.js';

/**
 * Accepts a page-inspection request and hands it to the queue.
 *
 * Like submitExecution this does no browser work: it validates, persists and
 * enqueues, so a page that hangs for thirty seconds occupies a worker rather
 * than a public API connection.
 */

export interface SubmitInspectionDeps {
  readonly store: InspectionStorePort;
  readonly queue: InspectionQueuePort;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface SubmitInspectionInput {
  readonly request: InspectionRequestV1;
  /** From the Idempotency-Key header; a retry must not open a second browser. */
  readonly idempotencyKey?: string;
}

export async function submitInspection(
  deps: SubmitInspectionDeps,
  input: SubmitInspectionInput,
): Promise<Result<InspectionAcceptedV1>> {
  const { store, queue, clock, logger } = deps;
  const { request, idempotencyKey } = input;

  if (request.contractVersion !== INSPECTION_CONTRACT_VERSION) {
    return err(
      RunnerErrors.contractVersionUnsupported(String(request.contractVersion), [
        INSPECTION_CONTRACT_VERSION,
      ]),
    );
  }

  // The schema constrains the scheme, but this use case is reachable without a
  // controller in front of it, and a URL that only fails inside the browser
  // would be reported as an infrastructure problem rather than a bad request.
  const urlCheck = checkUrl(request.url);
  if (!urlCheck.ok) return urlCheck;

  if (idempotencyKey !== undefined) {
    const existing = await store.findByIdempotencyKey(request.workspaceRef, idempotencyKey);
    if (existing.ok && existing.value !== undefined) {
      logger.info('Returning existing inspection for idempotency key', {
        inspectionId: existing.value.inspectionId,
        idempotencyKey,
      });
      return ok(toAccepted(existing.value));
    }
  }

  const inspectionId = newInspectionId();
  const queuedAt = clock.nowIso();

  const record: InspectionRecord = {
    inspectionId,
    workspaceRef: request.workspaceRef,
    ...(request.tenantRef === undefined ? {} : { tenantRef: request.tenantRef }),
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    status: 'QUEUED',
    requestedUrl: request.url,
    request,
    queuedAt,
  };

  const created = await store.create(record);
  if (!created.ok) return created;

  if (idempotencyKey !== undefined) {
    const saved = await store.saveIdempotencyKey(
      request.workspaceRef,
      idempotencyKey,
      inspectionId,
    );
    if (!saved.ok) {
      logger.warn('Could not persist idempotency key', {
        inspectionId,
        errorCode: saved.error.code,
      });
    }
  }

  const enqueued = await queue.enqueue({
    inspectionId,
    workspaceRef: request.workspaceRef,
    enqueuedAt: queuedAt,
  });

  if (!enqueued.ok) {
    // Recorded FAILED rather than left QUEUED, so an inspection no worker will
    // ever pick up is visible instead of appearing to hang forever.
    await store.updateStatus(inspectionId, 'FAILED', {
      completedAt: clock.nowIso(),
      error: enqueued.error.toJSON(),
    });
    return err(enqueued.error);
  }

  logger.info('Inspection queued', { inspectionId, requestId: request.requestId });
  return ok(toAccepted(created.value));
}

/**
 * Rejects anything but http(s).
 *
 * `file:`, `data:` and custom schemes would let a caller point the Runner's
 * browser at the worker's own filesystem or an internal service, so they are a
 * contract violation rather than a navigation failure.
 */
function checkUrl(url: string): Result<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return err(RunnerErrors.validationFailed(`"${url}" is not a valid absolute URL.`, { url }));
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return err(
      RunnerErrors.validationFailed('Only http and https URLs can be inspected.', {
        url,
        protocol: parsed.protocol,
      }),
    );
  }
  return ok(undefined);
}

function toAccepted(record: InspectionRecord): InspectionAcceptedV1 {
  const accepted: Record<string, unknown> = {
    inspectionId: record.inspectionId,
    status: record.status,
    statusUrl: `/api/v1/inspections/${record.inspectionId}`,
    acceptedAt: record.queuedAt,
  };
  if (record.requestId !== undefined) accepted.requestId = record.requestId;
  return accepted as unknown as InspectionAcceptedV1;
}
