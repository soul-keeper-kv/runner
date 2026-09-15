import type { ElementCandidate, ElementIntent } from '@runner/domain';
import type { ElementRegistryItem } from '@runner/registry-model';
import { RunnerError, type Result } from '@runner/shared';

/**
 * The AI boundary (blueprint section 45).
 *
 * Three constraints are built into this interface on purpose:
 *
 *  1. It takes a *shortlist* of candidates, not a page. Deterministic filtering
 *     runs first and hands over roughly ten elements, never a hundred.
 *  2. It only ranks. It never executes, navigates, or writes to the Registry —
 *     an LLM must not become the executor (blueprint rule 12).
 *  3. It is optional. Phases 0-12 run with no implementation bound at all.
 */

export interface SemanticRanking {
  readonly runtimeId?: string;
  readonly elementId?: string;
  /** 0..1 confidence in this candidate. */
  readonly score: number;
  readonly reasoning: string;
}

export interface SemanticResolutionResult {
  readonly rankings: readonly SemanticRanking[];
  readonly modelRef?: string;
  readonly latencyMs?: number;
}

export interface SemanticResolverPort {
  readonly available: boolean;

  rankElements(input: {
    readonly intent: ElementIntent;
    /** Pre-filtered shortlist. Implementations may reject oversized input. */
    readonly candidates: readonly ElementCandidate[];
    readonly registryCandidates: readonly ElementRegistryItem[];
    readonly pageUrl?: string;
  }): Promise<Result<SemanticResolutionResult>>;
}

/** The default binding for every phase before AI is introduced. */
export const unavailableSemanticResolver: SemanticResolverPort = {
  available: false,
  rankElements: () =>
    Promise.resolve({
      ok: false,
      error: new RunnerError(
        'CAPABILITY_NOT_IMPLEMENTED',
        'No semantic resolver is configured. Deterministic resolution only.',
      ),
    }),
};
