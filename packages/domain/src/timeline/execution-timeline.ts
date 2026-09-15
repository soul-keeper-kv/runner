import type { RunnerErrorJson } from '@runner/shared';
import type { ResolvedElement } from '../element/resolved-element.js';

/**
 * The per-step record of an execution (blueprint section 43).
 *
 * Rule 10: every step must be traceable. Each item records not only the
 * outcome but the state either side of it and the Registry revision in force,
 * which is what makes "retry from here" and later replay meaningful.
 */

export type StepStatus = 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED' | 'WAITING_USER';

export interface ExecutionTimelineItem {
  readonly stepId: string;
  readonly type: string;
  readonly label: string;
  readonly status: StepStatus;

  readonly beforeStateId?: string;
  readonly afterStateId?: string;

  readonly resolvedElement?: ResolvedElement;
  readonly evidence: readonly string[];
  readonly error?: RunnerErrorJson;

  /** Registry revision in force when this step ran, for reproducibility. */
  readonly registryRevision?: number;

  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly artifactIds: readonly string[];
  readonly attempt: number;
}

export interface ExecutionTimeline {
  readonly executionId: string;
  readonly items: readonly ExecutionTimelineItem[];
}

export function pendingItem(stepId: string, type: string, label: string): ExecutionTimelineItem {
  return {
    stepId,
    type,
    label,
    status: 'PENDING',
    evidence: [],
    artifactIds: [],
    attempt: 0,
  };
}

export function timelineStatus(
  timeline: ExecutionTimeline,
): 'PASSED' | 'FAILED' | 'RUNNING' | 'WAITING_USER' {
  const { items } = timeline;
  if (items.some((item) => item.status === 'WAITING_USER')) return 'WAITING_USER';
  if (items.some((item) => item.status === 'FAILED')) return 'FAILED';
  if (items.some((item) => item.status === 'RUNNING' || item.status === 'PENDING')) {
    return 'RUNNING';
  }
  return 'PASSED';
}

export function currentItem(timeline: ExecutionTimeline): ExecutionTimelineItem | undefined {
  return (
    timeline.items.find((item) => item.status === 'RUNNING') ??
    timeline.items.find((item) => item.status === 'WAITING_USER') ??
    timeline.items.find((item) => item.status === 'PENDING')
  );
}
