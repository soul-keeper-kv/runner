import type { InspectionErrorV1, InspectionResultV1 } from '@runner/test-ir-model';
import { ok, type Result } from '@runner/shared';
import type { InspectionRecord, InspectionStorePort } from '../ports/inspection-store-port.js';

export interface GetInspectionDeps {
  readonly store: InspectionStorePort;
}

/** Backs GET /api/v1/inspections/:id — the polling integration style. */
export async function getInspection(
  deps: GetInspectionDeps,
  inspectionId: string,
): Promise<Result<InspectionResultV1>> {
  const found = await deps.store.get(inspectionId);
  if (!found.ok) return found;
  return ok(toInspectionResult(found.value));
}

/**
 * Projects the stored record onto the published result shape.
 *
 * A record that has not completed still answers with its status and an empty
 * field list rather than a partial object, so a polling caller can rely on the
 * same shape throughout and switch on `status` alone.
 */
export function toInspectionResult(record: InspectionRecord): InspectionResultV1 {
  const findings = record.findings;

  const result: Record<string, unknown> = {
    inspectionId: record.inspectionId,
    status: record.status,
    url: findings?.url ?? record.requestedUrl,
    requestedUrl: record.requestedUrl,
    elements: findings?.elements ?? [],
    fields: findings?.fields ?? [],
    queuedAt: record.queuedAt,
  };

  if (record.requestId !== undefined) result.requestId = record.requestId;
  if (findings?.title !== undefined) result.title = findings.title;
  if (findings?.page !== undefined) result.page = findings.page;
  if (findings?.submit !== undefined) result.submit = findings.submit;
  if (findings?.controls !== undefined) result.controls = findings.controls;
  if (record.startedAt !== undefined) result.startedAt = record.startedAt;
  if (record.completedAt !== undefined) result.completedAt = record.completedAt;
  if (record.error !== undefined) result.error = record.error as InspectionErrorV1;

  return result as unknown as InspectionResultV1;
}
