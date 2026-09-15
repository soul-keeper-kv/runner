import type { ElementRegistryItem } from '@runner/registry-model';
import {
  bonus,
  clampScore,
  penalty,
  stabilityOfScore,
  type ScoreAdjustment,
  type ScoredSelector,
  type SelectorStability,
} from '@runner/selector-model';

/**
 * Applies contextual adjustments on top of a generated selector's base score
 * (blueprint section 14).
 *
 * The generator scores a selector in isolation: it can see that a `data-testid`
 * beats an XPath, but not that *this particular* selector has succeeded forty
 * times, or that a human confirmed it last week, or that it just matched three
 * elements instead of one. Those signals only exist at resolution time, and
 * folding them in here is what lets the Runner improve with use rather than
 * scoring identically forever.
 */

export interface ScoringContext {
  /** Match count from live validation, when the selector has been probed. */
  readonly matchCount?: number;
  /** The registry entry this selector belongs to, when there is one. */
  readonly registryElement?: ElementRegistryItem;
  /** True when the element was found inside the expected component subtree. */
  readonly matchedExpectedComponent?: boolean;
  readonly matchedExpectedPage?: boolean;
}

export interface RankedSelector extends ScoredSelector {
  readonly stability: SelectorStability;
  readonly matchCount?: number;
}

export interface LocatorScorer {
  score(selector: ScoredSelector, context: ScoringContext): RankedSelector;
  rank(selectors: readonly ScoredSelector[], context: ScoringContext): RankedSelector[];
}

export class DefaultLocatorScorer implements LocatorScorer {
  score(selector: ScoredSelector, context: ScoringContext): RankedSelector {
    const adjustments: ScoreAdjustment[] = [...selector.adjustments];

    // A selector that matches more than one element is not a selector for *an*
    // element; this penalty is deliberately heavy.
    if (context.matchCount !== undefined && context.matchCount > 1) {
      adjustments.push(penalty('nonUnique', `matched ${context.matchCount} elements`));
    }

    const registryElement = context.registryElement;
    if (registryElement !== undefined) {
      if (registryElement.userConfirmed) {
        adjustments.push(bonus('userConfirmed'));
      }

      const history = this.historyFor(registryElement, selector);
      if (history !== undefined && history.successCount >= 5 && history.failureCount === 0) {
        adjustments.push(
          bonus('historicallyStable', `${history.successCount} consecutive successes`),
        );
      }
    }

    if (context.matchedExpectedComponent === true) {
      adjustments.push(bonus('matchedExpectedComponent'));
    }
    if (context.matchedExpectedPage === true) {
      adjustments.push(bonus('matchedExpectedPage'));
    }

    const total = adjustments.reduce((sum, adjustment) => sum + adjustment.delta, selector.baseScore);
    const score = clampScore(total);

    return {
      selector: selector.selector,
      baseScore: selector.baseScore,
      score,
      adjustments,
      stability: stabilityOfScore(score),
      ...(context.matchCount === undefined ? {} : { matchCount: context.matchCount }),
    };
  }

  rank(selectors: readonly ScoredSelector[], context: ScoringContext): RankedSelector[] {
    return selectors
      .map((selector) => this.score(selector, context))
      .sort((a, b) => b.score - a.score);
  }

  private historyFor(
    element: ElementRegistryItem,
    scored: ScoredSelector,
  ): { successCount: number; failureCount: number } | undefined {
    const entry = element.fallbackSelectors.find(
      (fallback) => JSON.stringify(fallback.selector) === JSON.stringify(scored.selector),
    );
    if (entry === undefined) return undefined;

    return {
      successCount: entry.successCount ?? 0,
      failureCount: entry.failureCount ?? 0,
    };
  }
}
