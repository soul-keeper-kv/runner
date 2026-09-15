import type { SelectorDefinition, SelectorStrategy } from './selector-definition.js';

/**
 * Deterministic base scores per strategy (blueprint section 14).
 *
 * These are the starting weights, not a finished heuristic. They are data
 * rather than inline constants so scoring stays tunable per workspace and
 * testable in isolation, before any AI reranking exists.
 */
export const SELECTOR_BASE_SCORES: Readonly<Record<SelectorStrategy, number>> = {
  testId: 100,
  role: 95,
  label: 90,
  placeholder: 85,
  altText: 80,
  title: 70,
  text: 75,
  css: 60,
  xpath: 30,
};

/** Named penalties applied on top of the base score. */
export const SELECTOR_PENALTIES = {
  dynamicId: -40,
  nthChild: -50,
  generatedClass: -30,
  nonUnique: -50,
  veryLongSelector: -20,
  positionalXPath: -35,
} as const;

/** Named bonuses that accumulate as the Runner learns (section 14). */
export const SELECTOR_BONUSES = {
  userConfirmed: 40,
  historicallyStable: 20,
  matchedExpectedComponent: 15,
  matchedExpectedPage: 10,
} as const;

export type SelectorPenalty = keyof typeof SELECTOR_PENALTIES;
export type SelectorBonus = keyof typeof SELECTOR_BONUSES;

/** A single scoring decision, retained so a score can always be explained. */
export interface ScoreAdjustment {
  readonly reason: SelectorPenalty | SelectorBonus;
  readonly delta: number;
  readonly detail?: string;
}

export interface ScoredSelector {
  readonly selector: SelectorDefinition;
  /** Final score, clamped to 0..100. */
  readonly score: number;
  readonly baseScore: number;
  readonly adjustments: readonly ScoreAdjustment[];
}

/** Qualitative band derived from a score, for display in the live workspace. */
export type SelectorStability = 'HIGH' | 'MEDIUM' | 'LOW';

export function stabilityOfScore(score: number): SelectorStability {
  if (score >= 85) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  return 'LOW';
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Combines a base strategy score with adjustments.
 * Kept pure so the scoring policy can be unit-tested without a browser.
 */
export function computeScore(
  strategy: SelectorStrategy,
  adjustments: readonly ScoreAdjustment[] = [],
): { score: number; baseScore: number } {
  const baseScore = SELECTOR_BASE_SCORES[strategy];
  const total = adjustments.reduce((sum, adjustment) => sum + adjustment.delta, baseScore);
  return { score: clampScore(total), baseScore };
}

export function penalty(reason: SelectorPenalty, detail?: string): ScoreAdjustment {
  return detail === undefined
    ? { reason, delta: SELECTOR_PENALTIES[reason] }
    : { reason, delta: SELECTOR_PENALTIES[reason], detail };
}

export function bonus(reason: SelectorBonus, detail?: string): ScoreAdjustment {
  return detail === undefined
    ? { reason, delta: SELECTOR_BONUSES[reason] }
    : { reason, delta: SELECTOR_BONUSES[reason], detail };
}
