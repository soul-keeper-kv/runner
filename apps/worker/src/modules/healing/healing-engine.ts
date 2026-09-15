import type { BrowserPort, RegistryPort } from '@runner/application';
import type { PageSnapshot } from '@runner/domain';
import {
  allNamesOf,
  canAutoCommitHealing,
  type ElementRegistryItem,
  type RegistryModification,
} from '@runner/registry-model';
import { describeSelector, type SelectorDefinition } from '@runner/selector-model';
import { RunnerErrors, err, ok, type Clock, type Logger, type Result } from '@runner/shared';
import {
  filterInteractable,
  rankByTextSimilarity,
} from '../inspector/candidate-filter.js';
import { DefaultLocatorGenerator, type LocatorGenerator } from '../locator/locator-generator.js';
import { DefaultLocatorScorer, type LocatorScorer } from '../locator/locator-scorer.js';
import {
  DefaultLocatorValidator,
  type LocatorValidator,
} from '../locator/locator-validator.js';

/**
 * Proposes a replacement when a stored selector stops matching
 * (blueprint section 24).
 *
 * The invariant that governs this whole module: **healing never mutates the
 * Registry.** It produces a *proposal* — a `RegistryModification` with an
 * explicit before/after — which AUTO mode may commit under policy and REVIEW
 * mode puts in front of a human. Silently rewriting a confirmed selector would
 * make the Registry untrustworthy exactly when it matters most: the moment a
 * test starts failing is the moment a person most needs to know what changed.
 *
 * How a replacement is found matters as much as that it is found. The element is
 * re-located by its **meaning** — its display name and the aliases it answers to
 * — and never by "whatever is near where the old selector used to point".
 * Position-based healing produces a Runner that confidently heals its way onto
 * the wrong control.
 *
 * It also refuses to heal what is not broken, and refuses to heal what it cannot
 * distinguish: a candidate that resolves ambiguously is not a fix.
 */

export interface HealingDeps {
  readonly registry: RegistryPort;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly generator?: LocatorGenerator;
  readonly scorer?: LocatorScorer;
  readonly validator?: LocatorValidator;
}

export interface HealingInput {
  readonly element: ElementRegistryItem;
  readonly snapshot: PageSnapshot;
  readonly browser: BrowserPort;
  readonly executionId: string;
  /** Drives whether the proposal may be auto-committed by the caller. */
  readonly mode: 'AUTO' | 'REVIEW' | 'INTERACTIVE';
}

export interface HealingProposal {
  readonly modification: RegistryModification;
  readonly replacement: SelectorDefinition;
  readonly previous: SelectorDefinition;
  /** 0..1 in the replacement. Compared against `autoHealThreshold`. */
  readonly confidence: number;
  /**
   * True when policy permits the caller to confirm this without asking.
   * The engine never acts on it itself — that is the caller's decision to make
   * and to record.
   */
  readonly autoCommittable: boolean;
  readonly evidence: readonly string[];
}

/** How many candidates are considered before healing gives up. */
const MAX_CANDIDATES = 5;
/** How many selectors per candidate are probed. */
const MAX_SELECTORS = 4;
/**
 * Below this, a replacement is not offered at all.
 *
 * A weak heal is worse than none: it replaces a selector a human confirmed with
 * a guess, and the next failure is then harder to diagnose because the stored
 * mapping no longer reflects anyone's decision.
 */
const MIN_HEAL_CONFIDENCE = 0.6;

export class HealingEngine {
  private readonly generator: LocatorGenerator;
  private readonly scorer: LocatorScorer;
  private readonly validator: LocatorValidator;

  constructor(private readonly deps: HealingDeps) {
    this.generator = deps.generator ?? new DefaultLocatorGenerator();
    this.scorer = deps.scorer ?? new DefaultLocatorScorer();
    this.validator = deps.validator ?? new DefaultLocatorValidator();
  }

  /**
   * Finds a replacement selector for an element whose stored one has stopped
   * matching, and records the intent to change it.
   *
   * Returns `ELEMENT_NOT_FOUND` when the element genuinely is not on the page.
   * That distinction is the one blueprint section 21 insists on: a selector that
   * broke and an element that is not there yet need different fixes, and healing
   * must not paper over the second.
   */
  async proposeReplacement(input: HealingInput): Promise<Result<HealingProposal>> {
    // `snapshot` is read by findByMeaning from `input`, not here.
    const { element, browser, executionId, mode } = input;
    const logger = this.deps.logger.child({ runId: executionId, elementId: element.id });

    // Heal only what is broken. If the stored selector still resolves uniquely,
    // the failure was something else — a precondition, a timing issue, a genuine
    // bug — and replacing the selector would hide it.
    const existing = await this.validator.validate(browser, {
      selector: element.primarySelector,
    });
    if (existing.ok && existing.value.outcome === 'VALID') {
      return err(
        RunnerErrors.validationFailed(
          `Selector ${describeSelector(element.primarySelector)} still matches; there is nothing to heal.`,
          { elementId: element.id },
        ),
      );
    }

    const candidate = await this.findByMeaning(input, logger);
    if (!candidate.ok) return candidate;

    const { selector, score, matchCount, similarity } = candidate.value;
    const confidence = confidenceOf(score, similarity, element.userConfirmed);

    if (confidence < MIN_HEAL_CONFIDENCE) {
      return err(
        RunnerErrors.elementNotFound(`healing candidate for "${element.displayName}"`, {
          reason: `best replacement scored ${confidence.toFixed(2)}, below the ${MIN_HEAL_CONFIDENCE} floor`,
          elementId: element.id,
        }),
      );
    }

    const evidence = [
      `stored selector ${describeSelector(element.primarySelector)} no longer matches`,
      `re-located "${element.displayName}" by name with similarity ${similarity.toFixed(2)}`,
      `replacement ${describeSelector(selector)} scored ${score} and matched ${matchCount} element`,
    ];

    // The replaced selector is pushed onto history rather than discarded:
    // knowing what a selector used to be is what lets a reviewer judge whether
    // the heal was right, and what a later heal compares against.
    const proposed = await this.deps.registry.proposeModification({
      workspaceRef: element.workspaceRef,
      entityKind: 'ELEMENT',
      entityId: element.id,
      type: 'SELECTOR_UPDATE',
      before: { primarySelector: element.primarySelector },
      after: {
        primarySelector: selector,
        selectorHistory: [
          ...element.selectorHistory,
          {
            selector: element.primarySelector,
            replacedAt: this.deps.clock.nowIso(),
            replacedBy: 'HEALING' as const,
            reason: `stopped matching during execution ${executionId}`,
          },
        ],
      },
      proposedBy: 'HEALING',
      reason: evidence.join('; '),
      executionId,
      // PROPOSED, not DRAFT: this is a finished suggestion awaiting a decision,
      // not something half-authored.
      status: 'PROPOSED',
    });
    if (!proposed.ok) return proposed;

    const autoCommittable = canAutoCommitHealing(confidence, mode);

    logger.info('Healing proposed a replacement selector', {
      modificationId: proposed.value.id,
      confidence,
      selectorStrategy: selector.type,
      result: autoCommittable ? 'auto-committable' : 'needs review',
    });

    return ok({
      modification: proposed.value,
      replacement: selector,
      previous: element.primarySelector,
      confidence,
      autoCommittable,
      evidence,
    });
  }

  /**
   * Re-locates the element by what it *means*, then finds a selector that
   * uniquely identifies it.
   *
   * Every name the element answers to is tried — the display name a person gave
   * it and each alias — because a UI change often renames the visible label while
   * an alias still matches.
   */
  private async findByMeaning(
    input: HealingInput,
    logger: Logger,
  ): Promise<
    Result<{
      selector: SelectorDefinition;
      score: number;
      matchCount: number;
      similarity: number;
    }>
  > {
    const { element, snapshot, browser } = input;

    const visible = filterInteractable(snapshot.elements, {
      requireVisible: true,
      requireEnabled: false,
      requireInteractable: false,
    });

    if (visible.length === 0) {
      return err(
        RunnerErrors.elementNotFound(`"${element.displayName}"`, {
          reason: 'the page snapshot contained no visible elements',
          elementId: element.id,
        }),
      );
    }

    const attempts: string[] = [];

    for (const name of allNamesOf(element)) {
      const ranked = rankByTextSimilarity(visible, {
        name,
        ...(element.role === undefined ? {} : { role: element.role }),
      }).slice(0, MAX_CANDIDATES);

      for (const { candidate, similarity } of ranked) {
        // The same floor the resolver uses: an element whose label resembles
        // nothing we are looking for is not a healing candidate.
        if (similarity < 0.4) continue;

        const generated = this.generator.generate(candidate).slice(0, MAX_SELECTORS);
        const scored = this.scorer.rank(generated, { registryElement: element });

        for (const entry of scored) {
          const validated = await this.validator.validate(
            browser,
            { selector: entry.selector },
            {},
          );
          if (!validated.ok) {
            attempts.push(`${describeSelector(entry.selector)}: ${validated.error.message}`);
            continue;
          }

          // An ambiguous replacement is not a fix. Healing onto a selector that
          // matches three elements trades a failing test for a wrong one.
          if (validated.value.outcome !== 'VALID') {
            attempts.push(`${describeSelector(entry.selector)}: ${validated.value.reason}`);
            continue;
          }

          return ok({
            selector: entry.selector,
            score: this.scorer.score(entry, {
              matchCount: validated.value.matchCount,
              registryElement: element,
            }).score,
            matchCount: validated.value.matchCount,
            similarity,
          });
        }
      }
    }

    logger.debug('Healing found no usable replacement', {
      names: allNamesOf(element).length,
      attempts: attempts.length,
    });

    return err(
      RunnerErrors.elementNotFound(`"${element.displayName}"`, {
        reason: 'no candidate on the page matched this element by name and resolved uniquely',
        elementId: element.id,
        attempts: attempts.slice(0, 10),
      }),
    );
  }
}

/**
 * Confidence in a proposed replacement.
 *
 * Deliberately *not* the same formula as `computeElementConfidence`: that one
 * rewards a user confirmation, which here belongs to the selector being
 * replaced, not to the new one. A confirmed element earns a small amount of
 * trust — someone did verify this element exists and matters — but never enough
 * on its own to clear the auto-heal threshold.
 */
export function confidenceOf(
  selectorScore: number,
  similarity: number,
  userConfirmed: boolean,
): number {
  const normalized = Math.max(0, Math.min(100, selectorScore)) / 100;
  const base = normalized * 0.6 + similarity * 0.4;
  const adjusted = userConfirmed ? Math.min(1, base + 0.02) : base;
  return Math.round(adjusted * 1000) / 1000;
}
