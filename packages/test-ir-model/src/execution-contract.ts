import type { TestIrV1 } from './test-action.js';

/**
 * The public execution contract, version `runner.execution.v1`
 * (blueprint sections 7.1, 3.9 and 52).
 *
 * Every field crossing this boundary is either an opaque reference to another
 * service's data (`tenantRef`, `externalTestCaseRef`) or Runner-owned. The
 * Runner deliberately does not model the caller's database.
 */

export const EXECUTION_CONTRACT_VERSION = 'runner.execution.v1' as const;
export type ExecutionContractVersion = typeof EXECUTION_CONTRACT_VERSION;

/** Execution modes (blueprint section 39). */
export const EXECUTION_MODES = ['AUTO', 'REVIEW', 'INTERACTIVE'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_USER',
  'PASSED',
  'FAILED',
  'CANCELLED',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Statuses from which no further transition occurs. */
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'PASSED',
  'FAILED',
  'CANCELLED',
];

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.includes(status);
}

export const PUBLIC_EXECUTION_EVENTS = [
  'execution.queued',
  'execution.started',
  'execution.step.started',
  'execution.step.completed',
  'execution.waiting_user',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
] as const;
export type PublicExecutionEventType = (typeof PUBLIC_EXECUTION_EVENTS)[number];

export interface ExecutionCallbackV1 {
  readonly url: string;
  readonly events: readonly PublicExecutionEventType[];
  /** Header name used to carry a shared-secret signature, if the caller wants one. */
  readonly signatureHeader?: string;
}

export interface ExecutionOptionsV1 {
  readonly headless?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly baseUrl?: string;
  readonly defaultTimeoutMs?: number;
  /** Stop the run at the first failed step. Defaults to true. */
  readonly stopOnFailure?: boolean;
  /** Let the Runner record newly discovered elements into the Registry. */
  readonly enableRegistryLearning?: boolean;
  /** Let the Runner propose replacement selectors when a stored one fails. */
  readonly enableSelfHealing?: boolean;
}

export interface ExecutionRequestV1 {
  readonly contractVersion: ExecutionContractVersion;
  readonly irVersion: string;
  /** Caller-side correlation id, echoed in every result and event. */
  readonly requestId?: string;

  // --- opaque references owned by the calling service ---
  readonly tenantRef?: string;
  readonly workspaceRef: string;
  readonly externalTestCaseRef?: string;

  // --- Runner-owned references ---
  readonly environmentRef?: string;
  readonly authProfileRef?: string;

  readonly mode?: ExecutionMode;
  readonly test: TestIrV1;
  readonly options?: ExecutionOptionsV1;
  readonly callback?: ExecutionCallbackV1;
}

/** The 202 response body returned by POST /api/v1/executions. */
export interface ExecutionAcceptedV1 {
  readonly executionId: string;
  readonly status: ExecutionStatus;
  readonly statusUrl: string;
  readonly eventsUrl: string;
  readonly requestId?: string;
  readonly acceptedAt: string;
}

export interface ResolvedElementSummaryV1 {
  readonly elementId?: string;
  readonly displayName?: string;
  readonly confidence: number;
  readonly selector: unknown;
  readonly alternatives?: readonly unknown[];
}

export interface ExecutionErrorV1 {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export interface ExecutionStepResultV1 {
  readonly stepId: string;
  readonly type: string;
  readonly status: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly resolvedElement?: ResolvedElementSummaryV1;
  /** Human-readable reasons behind the resolution decision. */
  readonly evidence?: readonly string[];
  readonly error?: ExecutionErrorV1;
  readonly artifactIds?: readonly string[];
}

export interface ExecutionResultV1 {
  readonly contractVersion: ExecutionContractVersion;
  readonly executionId: string;
  readonly requestId?: string;
  readonly workspaceRef: string;
  readonly externalTestCaseRef?: string;
  readonly status: ExecutionStatus;
  readonly mode: ExecutionMode;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly steps: readonly ExecutionStepResultV1[];
  readonly error?: ExecutionErrorV1;
}

export interface PublicExecutionEventV1 {
  readonly type: PublicExecutionEventType;
  readonly executionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly payload?: Record<string, unknown>;
}
