import type { ExecutionTimelineItem, ResolvedElement, StepStatus } from '@runner/domain';
import type { RunnerError } from '@runner/shared';
import type { Clock } from '@runner/shared';

/**
 * Maintains the per-step record of an execution (blueprint section 43).
 *
 * Rule 10 of the blueprint: every step must be traceable. This keeps one item
 * per step and updates it in place through the step's lifecycle, so the
 * timeline is always a complete picture rather than an append-only log a reader
 * has to reconstruct.
 */
export class TimelineBuilder {
  private readonly items = new Map<string, ExecutionTimelineItem>();

  constructor(
    private readonly clock: Clock,
    initialItems: readonly ExecutionTimelineItem[] = [],
  ) {
    for (const item of initialItems) this.items.set(item.stepId, item);
  }

  start(stepId: string, type: string, label: string): ExecutionTimelineItem {
    const existing = this.items.get(stepId);
    const item: ExecutionTimelineItem = {
      ...(existing ?? { evidence: [], artifactIds: [], attempt: 0 }),
      stepId,
      type,
      label,
      status: 'RUNNING',
      startedAt: this.clock.nowIso(),
      // Retries increment the attempt counter rather than replacing history.
      attempt: (existing?.attempt ?? 0) + 1,
    };
    this.items.set(stepId, item);
    return item;
  }

  complete(
    stepId: string,
    status: Extract<StepStatus, 'PASSED' | 'FAILED' | 'SKIPPED' | 'WAITING_USER'>,
    details: {
      readonly evidence?: readonly string[];
      readonly error?: RunnerError;
      readonly resolvedElement?: ResolvedElement;
      readonly artifactIds?: readonly string[];
    } = {},
  ): ExecutionTimelineItem {
    const existing = this.items.get(stepId);
    const completedAt = this.clock.nowIso();

    const item: ExecutionTimelineItem = {
      stepId,
      type: existing?.type ?? 'unknown',
      label: existing?.label ?? stepId,
      status,
      evidence: details.evidence ?? existing?.evidence ?? [],
      artifactIds: details.artifactIds ?? existing?.artifactIds ?? [],
      attempt: existing?.attempt ?? 1,
      ...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
      completedAt,
      ...(existing?.startedAt === undefined
        ? {}
        : {
            durationMs:
              new Date(completedAt).getTime() - new Date(existing.startedAt).getTime(),
          }),
      ...(details.resolvedElement === undefined
        ? {}
        : { resolvedElement: details.resolvedElement }),
      ...(details.error === undefined ? {} : { error: details.error.toJSON() }),
    };

    this.items.set(stepId, item);
    return item;
  }

  /** Marks a step skipped, e.g. when an earlier step failed and stopped the run. */
  skip(stepId: string, reason: string): ExecutionTimelineItem {
    return this.complete(stepId, 'SKIPPED', { evidence: [reason] });
  }

  snapshot(): ExecutionTimelineItem[] {
    return [...this.items.values()];
  }

  get(stepId: string): ExecutionTimelineItem | undefined {
    return this.items.get(stepId);
  }
}
