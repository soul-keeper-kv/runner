import type { ExecutionTimelineItem, ResolvedElement } from '@runner/domain';
import type {
  ExecutionResultV1,
  ExecutionStatus,
  ExecutionStepResultV1,
  ResolvedElementSummaryV1,
} from '@runner/test-ir-model';
import { EXECUTION_CONTRACT_VERSION } from '@runner/test-ir-model';
import type { ExecutionRecord } from '../ports/execution-store-port.js';

/**
 * The outbound half of the anti-corruption layer.
 *
 * Internal timeline items carry more than a caller should see — full evidence
 * chains, runtime ids that only mean something inside one snapshot, internal
 * error causes. This narrows them to the published shape, which is also what
 * keeps the public contract stable while the internals keep moving.
 */

export function toExecutionResult(record: ExecutionRecord): ExecutionResultV1 {
  const result: Record<string, unknown> = {
    contractVersion: EXECUTION_CONTRACT_VERSION,
    executionId: record.executionId,
    workspaceRef: record.workspaceRef,
    status: record.status,
    mode: record.mode,
    steps: record.timeline.map(toStepResult),
  };

  if (record.requestId !== undefined) result.requestId = record.requestId;
  if (record.externalTestCaseRef !== undefined) {
    result.externalTestCaseRef = record.externalTestCaseRef;
  }
  if (record.startedAt !== undefined) result.startedAt = record.startedAt;
  if (record.completedAt !== undefined) result.completedAt = record.completedAt;
  if (record.startedAt !== undefined && record.completedAt !== undefined) {
    result.durationMs =
      new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime();
  }
  if (record.error !== undefined) result.error = record.error;

  return result as unknown as ExecutionResultV1;
}

export function toStepResult(item: ExecutionTimelineItem): ExecutionStepResultV1 {
  const step: Record<string, unknown> = {
    stepId: item.stepId,
    type: item.type,
    status: mapStepStatus(item.status),
  };

  if (item.startedAt !== undefined) step.startedAt = item.startedAt;
  if (item.completedAt !== undefined) step.completedAt = item.completedAt;
  if (item.durationMs !== undefined) step.durationMs = item.durationMs;
  if (item.resolvedElement !== undefined) {
    step.resolvedElement = toResolvedElementSummary(item.resolvedElement);
  }
  if (item.evidence.length > 0) step.evidence = item.evidence;
  if (item.error !== undefined) step.error = item.error;
  if (item.artifactIds.length > 0) step.artifactIds = item.artifactIds;

  return step as unknown as ExecutionStepResultV1;
}

export function toResolvedElementSummary(resolved: ResolvedElement): ResolvedElementSummaryV1 {
  const summary: Record<string, unknown> = {
    confidence: resolved.confidence,
    selector: resolved.locator,
  };
  if (resolved.elementId !== undefined) summary.elementId = resolved.elementId;
  if (resolved.displayName !== undefined) summary.displayName = resolved.displayName;
  if (resolved.alternatives.length > 0) summary.alternatives = resolved.alternatives;
  return summary as unknown as ResolvedElementSummaryV1;
}

/**
 * WAITING_USER is an internal step state; publicly a paused step is simply
 * still pending, and the execution-level status carries the distinction.
 */
function mapStepStatus(status: ExecutionTimelineItem['status']): ExecutionStepResultV1['status'] {
  return status === 'WAITING_USER' ? 'PENDING' : status;
}

export function deriveExecutionStatus(
  items: readonly ExecutionTimelineItem[],
  fallback: ExecutionStatus,
): ExecutionStatus {
  if (items.length === 0) return fallback;
  if (items.some((item) => item.status === 'WAITING_USER')) return 'WAITING_USER';
  if (items.some((item) => item.status === 'FAILED')) return 'FAILED';
  if (items.every((item) => item.status === 'PASSED' || item.status === 'SKIPPED')) {
    return 'PASSED';
  }
  return 'RUNNING';
}
