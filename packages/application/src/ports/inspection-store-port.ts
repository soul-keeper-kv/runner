import type {
  InspectionControlV1,
  InspectionElementV1,
  InspectionFieldV1,
  InspectionPageV1,
  InspectionRequestV1,
  InspectionStatus,
} from '@runner/test-ir-model';
import type { Result } from '@runner/shared';

/**
 * Page-inspection persistence.
 *
 * Shared by the API and the worker exactly as the execution store is: the API
 * writes a QUEUED record and enqueues, the worker reads it, drives the browser
 * and writes the findings back. Neither process imports the other's code.
 *
 * An inspection is a cache of what a page looked like at a moment, not a system
 * of record — so records expire, and a caller that needs current data submits
 * a new inspection rather than re-reading an old one.
 */

export interface InspectionFindings {
  readonly url: string;
  readonly title?: string;
  /** The page as a draft registry entry. */
  readonly page?: InspectionPageV1;
  /** Draft registry entries for every element found. */
  readonly elements: readonly InspectionElementV1[];
  readonly fields: readonly InspectionFieldV1[];
  readonly submit?: InspectionControlV1;
  readonly controls?: readonly InspectionControlV1[];
}

export interface InspectionRecord {
  readonly inspectionId: string;
  readonly workspaceRef: string;
  readonly tenantRef?: string;
  readonly requestId?: string;
  readonly status: InspectionStatus;
  /** The URL as submitted, kept even after a redirect changes the landed URL. */
  readonly requestedUrl: string;
  /** The exact submitted request, kept for audit and replay. */
  readonly request: InspectionRequestV1;
  readonly findings?: InspectionFindings;
  readonly error?: unknown;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface InspectionStorePort {
  create(record: InspectionRecord): Promise<Result<InspectionRecord>>;
  get(inspectionId: string): Promise<Result<InspectionRecord>>;
  updateStatus(
    inspectionId: string,
    status: InspectionStatus,
    patch?: Partial<Pick<InspectionRecord, 'startedAt' | 'completedAt' | 'error' | 'findings'>>,
  ): Promise<Result<InspectionRecord>>;
  /** Supports the Idempotency-Key header on inspection creation. */
  findByIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
  ): Promise<Result<InspectionRecord | undefined>>;
  saveIdempotencyKey(
    workspaceRef: string,
    idempotencyKey: string,
    inspectionId: string,
  ): Promise<Result<void>>;
}
