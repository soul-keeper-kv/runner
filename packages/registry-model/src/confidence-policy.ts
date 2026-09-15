/**
 * Confidence thresholds that decide whether the Runner acts alone or stops for
 * a human (blueprint section 40).
 *
 * Expressed as data so a workspace can tighten or relax the policy without a
 * code change, and so the decision is unit-testable without a browser.
 */

export interface ConfidencePolicy {
  /** At or above this, execute without asking. */
  readonly autoExecuteThreshold: number;
  /** Below this, always stop and wait for a human. */
  readonly reviewThreshold: number;
  /** In REVIEW mode, pause even in the middle band. */
  readonly pauseOnMediumConfidence: boolean;
  /** Commit a healing proposal automatically in AUTO mode above this score. */
  readonly autoHealThreshold: number;
}

export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicy = {
  autoExecuteThreshold: 0.95,
  reviewThreshold: 0.7,
  pauseOnMediumConfidence: true,
  autoHealThreshold: 0.97,
};

export type ConfidenceDecision = 'EXECUTE' | 'EXECUTE_WITH_WARNING' | 'WAITING_USER';

/**
 * Decides what to do with a resolution of a given confidence.
 *
 * AUTO trades certainty for throughput; REVIEW does the opposite. INTERACTIVE
 * is user-driven, so the Runner never proceeds on its own judgement there.
 */
export function decideByConfidence(
  confidence: number,
  mode: 'AUTO' | 'REVIEW' | 'INTERACTIVE',
  policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY,
): ConfidenceDecision {
  if (confidence < policy.reviewThreshold) return 'WAITING_USER';

  if (confidence >= policy.autoExecuteThreshold) {
    return mode === 'INTERACTIVE' ? 'WAITING_USER' : 'EXECUTE';
  }

  // Medium band: the resolution is plausible but not certain.
  switch (mode) {
    case 'AUTO':
      return 'EXECUTE_WITH_WARNING';
    case 'REVIEW':
      return policy.pauseOnMediumConfidence ? 'WAITING_USER' : 'EXECUTE_WITH_WARNING';
    case 'INTERACTIVE':
      return 'WAITING_USER';
  }
}

export function canAutoCommitHealing(
  confidence: number,
  mode: 'AUTO' | 'REVIEW' | 'INTERACTIVE',
  policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY,
): boolean {
  return mode === 'AUTO' && confidence >= policy.autoHealThreshold;
}

/**
 * Folds the signals that make up an element's confidence into a single 0..1
 * score. A human confirmation dominates, because a person looking at the real
 * page is better evidence than any heuristic.
 */
export function computeElementConfidence(input: {
  readonly selectorScore: number;
  readonly userConfirmed: boolean;
  readonly successCount?: number;
  readonly failureCount?: number;
}): number {
  const base = Math.max(0, Math.min(100, input.selectorScore)) / 100;

  const successes = input.successCount ?? 0;
  const failures = input.failureCount ?? 0;
  const attempts = successes + failures;
  // Laplace smoothing keeps a single early success from reading as certainty.
  const historyRatio = attempts === 0 ? 0.5 : (successes + 1) / (attempts + 2);

  const weighted = base * 0.6 + historyRatio * 0.4;
  const confirmed = input.userConfirmed ? Math.max(weighted, 0.96) : weighted;

  return Math.round(confirmed * 1000) / 1000;
}
