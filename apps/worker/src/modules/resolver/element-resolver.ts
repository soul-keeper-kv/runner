import type { BrowserPort, SemanticResolverPort } from '@runner/application';
import type {
  ElementCandidate,
  ElementIntent,
  PageSnapshot,
  ResolutionEvidence,
  ResolvedElement,
} from '@runner/domain';
import { describeCandidate, labelOf } from '@runner/domain';
import { describeSelector, type SelectorDefinition } from '@runner/selector-model';
import { RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';
import { DefaultLocatorGenerator, type LocatorGenerator } from '../locator/locator-generator.js';
import { DefaultLocatorScorer, type LocatorScorer } from '../locator/locator-scorer.js';
import {
  DefaultLocatorValidator,
  type LocatorValidator,
} from '../locator/locator-validator.js';
import {
  filterBySemantics,
  filterInteractable,
  rankByTextSimilarity,
} from '../inspector/candidate-filter.js';

/**
 * Turns an intent into a concrete, validated element (blueprint section 16).
 *
 * The pipeline is deterministic end to end:
 *
 *   shortlist candidates -> rank by text similarity -> generate selectors
 *   -> score -> validate against the live page -> return with evidence
 *
 * No model is consulted. That ordering is the blueprint's "rule-based first,
 * AI second" (section 3.5) made concrete, and it has a practical payoff beyond
 * cost: every decision is reproducible and explainable, so when a resolution is
 * wrong a human can see exactly which step went wrong.
 *
 * Registry-backed resolution (elementId, display name, alias) is layered on top
 * of this in Phase 4 — the `evidence` and `resolvedVia` fields already
 * distinguish those sources.
 */

export interface ResolveInput {
  readonly intent: ElementIntent;
  readonly snapshot: PageSnapshot;
  readonly browser: BrowserPort;
  /** Require the element to be actionable, as a click or fill would. */
  readonly requireInteractable?: boolean;
  readonly requireEditable?: boolean;
}

export interface ElementResolver {
  resolve(input: ResolveInput): Promise<Result<ResolvedElement>>;
}

/** How many shortlisted candidates are probed against the page. */
const MAX_CANDIDATES_TO_VALIDATE = 5;
/** How many selectors per candidate are probed before moving on. */
const MAX_SELECTORS_PER_CANDIDATE = 4;

/**
 * How well a candidate's label must match a named intent to be resolvable.
 *
 * `filterBySemantics` deliberately falls back to the whole candidate list when
 * no keyword matches, so that a failure reads as "nothing matched my keywords"
 * rather than "nothing on the page". That fallback is right for *diagnosis* and
 * wrong for *resolution*: without a floor here, an intent naming something that
 * does not exist still resolves to whichever candidate happens to rank first,
 * and the Runner clicks it with confidence.
 *
 * Set to match `MIN_NAME_MATCH_SIMILARITY` in the Registry, so DOM discovery and
 * Registry lookup agree on what counts as a match.
 */
const MIN_INTENT_SIMILARITY = 0.4;

export class DeterministicElementResolver implements ElementResolver {
  constructor(
    private readonly logger: Logger,
    private readonly generator: LocatorGenerator = new DefaultLocatorGenerator(),
    private readonly scorer: LocatorScorer = new DefaultLocatorScorer(),
    private readonly validator: LocatorValidator = new DefaultLocatorValidator(),
    /**
     * Optional, and consulted **last**: only when deterministic ranking has
     * already refused every candidate. The name of this class is the intent —
     * if AI starts looking like the fix for ordinary resolution, the bug is in
     * scoring or filtering and that is what should change.
     */
    private readonly semantic?: SemanticResolverPort,
  ) {}

  async resolve(input: ResolveInput): Promise<Result<ResolvedElement>> {
    const { intent, snapshot } = input;

    const requireInteractable = input.requireInteractable ?? true;

    const interactable = filterInteractable(snapshot.elements, {
      requireVisible: true,
      requireEnabled: requireInteractable,
      requireInteractable,
    });

    if (interactable.length === 0) {
      return err(
        RunnerErrors.elementNotFound(describeIntent(intent), {
          reason: requireInteractable
            ? 'the page snapshot contained no interactable elements'
            : 'the page snapshot contained no visible elements',
          url: snapshot.url,
        }),
      );
    }

    const shortlist = filterBySemantics(interactable, intent);
    const ranked = rankByTextSimilarity(shortlist, intent).slice(0, MAX_CANDIDATES_TO_VALIDATE);

    this.logger.debug('Resolution shortlist built', {
      total: snapshot.elements.length,
      interactable: interactable.length,
      shortlisted: shortlist.length,
      validating: ranked.length,
    });

    /*
     * Refuse to resolve a named intent that nothing on the page resembles.
     *
     * Without this, `filterBySemantics`'s recall fallback plus an unfiltered
     * ranking meant an intent naming a nonexistent element still resolved to
     * whichever candidate sorted first — so a click on a mistyped target hit an
     * unrelated control, and an `elementVisible` precondition for something
     * absent reported itself satisfied.
     *
     * Only applied when the intent carries text to compare. A role-only intent
     * has no name to score, and judging it by similarity would reject every
     * candidate.
     */
    const intentText = intent.name ?? intent.description;
    if (intentText !== undefined && intentText.trim().length > 0) {
      const best = ranked[0]?.similarity ?? 0;
      if (best < MIN_INTENT_SIMILARITY) {
        // Phase 13: labels failed, so ask the semantic resolver whether the
        // *context* identifies the element — the text around it, the form and
        // component it sits in. This is the last resort, never the first.
        const reranked = await this.trySemantic(input, shortlist);
        if (reranked !== undefined) return ok(reranked);

        return err(
          RunnerErrors.elementNotFound(describeIntent(intent), {
            reason: `no element's label resembled the intent (best similarity ${best.toFixed(2)} < ${MIN_INTENT_SIMILARITY})`,
            url: snapshot.url,
            closestLabels: ranked
              .slice(0, 3)
              .map((entry) => `${labelOf(entry.candidate)} (${entry.similarity.toFixed(2)})`),
          }),
        );
      }
    }

    const attempts: string[] = [];

    for (const { candidate, similarity } of ranked) {
      const resolved = await this.tryCandidate(input, candidate, similarity, attempts);
      if (resolved !== undefined) return ok(resolved);
    }

    // Ambiguity is reported separately from absence: the two need different
    // fixes, and telling them apart is what makes the error actionable.
    const ambiguous = attempts.some((attempt) => attempt.includes('matched'));
    return err(
      ambiguous
        ? RunnerErrors.elementAmbiguous(describeIntent(intent), ranked.length)
        : RunnerErrors.elementNotFound(describeIntent(intent), {
            url: snapshot.url,
            attempts: attempts.slice(0, 10),
            shortlistSize: shortlist.length,
          }),
    );
  }

  /**
   * Asks the semantic resolver to rerank the shortlist, and validates its pick.
   *
   * The model only ranks: whatever it returns is still put through the same
   * selector generation and live validation as any other candidate, so it cannot
   * produce a resolution the page does not agree with. Its answer is recorded as
   * `SEMANTIC_AI` with its own reasoning, so a reviewer can see that a model
   * chose this element and why.
   */
  private async trySemantic(
    input: ResolveInput,
    shortlist: readonly ElementCandidate[],
  ): Promise<ResolvedElement | undefined> {
    if (this.semantic === undefined || !this.semantic.available) return undefined;
    if (shortlist.length === 0) return undefined;

    const ranked = await this.semantic.rankElements({
      intent: input.intent,
      candidates: shortlist,
      registryCandidates: [],
      pageUrl: input.snapshot.url,
    });

    if (!ranked.ok || ranked.value.rankings.length === 0) return undefined;

    for (const ranking of ranked.value.rankings) {
      const candidate = shortlist.find((entry) => entry.runtimeId === ranking.runtimeId);
      if (candidate === undefined) continue;

      const attempts: string[] = [];
      const resolved = await this.tryCandidate(input, candidate, ranking.score, attempts);
      if (resolved === undefined) continue;

      this.logger.info('Semantic resolution chose a candidate labels had rejected', {
        confidence: ranking.score,
        result: ranked.value.modelRef,
      });

      return {
        ...resolved,
        resolvedVia: 'SEMANTIC_AI',
        evidence: [
          ...resolved.evidence,
          {
            source: 'SEMANTIC_AI',
            reason: ranking.reasoning,
            score: ranking.score,
          },
        ],
      };
    }

    return undefined;
  }

  /** Probes one candidate's selectors and returns a resolution if one holds. */
  private async tryCandidate(
    input: ResolveInput,
    candidate: ElementCandidate,
    similarity: number,
    attempts: string[],
  ): Promise<ResolvedElement | undefined> {
    const generated = this.generator.generate(candidate);
    if (generated.length === 0) {
      attempts.push(`${describeCandidate(candidate)}: no selector could be generated`);
      return undefined;
    }

    const rankedSelectors = this.scorer
      .rank(generated, {})
      .slice(0, MAX_SELECTORS_PER_CANDIDATE);

    for (const rankedSelector of rankedSelectors) {
      const validated = await this.validator.validate(
        input.browser,
        { selector: rankedSelector.selector },
        {
          ...(input.requireInteractable === undefined
            ? {}
            : { requireInteractable: input.requireInteractable }),
          ...(input.requireEditable === undefined
            ? {}
            : { requireEditable: input.requireEditable }),
        },
      );

      if (!validated.ok) {
        attempts.push(
          `${describeSelector(rankedSelector.selector)}: ${validated.error.message}`,
        );
        continue;
      }

      if (validated.value.outcome !== 'VALID') {
        attempts.push(
          `${describeSelector(rankedSelector.selector)}: ${validated.value.reason}`,
        );
        continue;
      }

      // Re-score now that the live match count is known; a selector that looked
      // strong but matches three elements must not win.
      const finalScore = this.scorer.score(rankedSelector, {
        matchCount: validated.value.matchCount,
      });

      const alternatives: SelectorDefinition[] = rankedSelectors
        .filter((entry) => entry !== rankedSelector)
        .map((entry) => entry.selector);

      const evidence = this.buildEvidence(candidate, rankedSelector.selector, {
        similarity,
        selectorScore: finalScore.score,
        matchCount: validated.value.matchCount,
        intent: input.intent,
      });

      return {
        runtimeId: candidate.runtimeId,
        confidence: this.confidenceOf(finalScore.score, similarity),
        locator: rankedSelector.selector,
        alternatives,
        evidence,
        resolvedVia: 'CANDIDATE_SCORING',
        matchCount: validated.value.matchCount,
      };
    }

    return undefined;
  }

  /**
   * Records why this element was chosen.
   *
   * Written for a human reviewing a paused REVIEW-mode step, so each line is a
   * short statement of fact rather than a debug dump.
   */
  private buildEvidence(
    candidate: ElementCandidate,
    selector: SelectorDefinition,
    context: {
      similarity: number;
      selectorScore: number;
      matchCount: number;
      intent: ElementIntent;
    },
  ): ResolutionEvidence[] {
    const evidence: ResolutionEvidence[] = [];

    if (context.intent.role !== undefined && candidate.role !== undefined) {
      evidence.push({
        source: 'DOM_DISCOVERY',
        reason: `role matched ${candidate.role}`,
      });
    }

    const intentText = context.intent.name ?? context.intent.description;
    if (intentText !== undefined) {
      evidence.push({
        source: 'DOM_DISCOVERY',
        reason: `accessible name "${labelOf(candidate)}" matched intent "${intentText}"`,
        score: Math.round(context.similarity * 100) / 100,
      });
    }

    evidence.push({
      source: 'CANDIDATE_SCORING',
      reason: `selector ${describeSelector(selector)} scored ${context.selectorScore}`,
      score: context.selectorScore,
    });

    evidence.push({
      source: 'CANDIDATE_SCORING',
      reason: `selector uniquely matched ${context.matchCount} visible element`,
    });

    return evidence;
  }

  /**
   * Combines selector quality with name-match quality into a 0..1 confidence.
   *
   * Both matter and neither is sufficient: a perfect `data-testid` pointing at
   * the wrong element is still wrong, and an exact name match through a
   * positional XPath is still fragile.
   */
  private confidenceOf(selectorScore: number, similarity: number): number {
    const normalizedScore = Math.max(0, Math.min(100, selectorScore)) / 100;
    const combined = normalizedScore * 0.6 + similarity * 0.4;
    return Math.round(combined * 1000) / 1000;
  }
}

function describeIntent(intent: ElementIntent): string {
  if (intent.elementId !== undefined) return `elementId=${intent.elementId}`;
  if (intent.name !== undefined) return `name="${intent.name}"`;
  if (intent.description !== undefined) return `description="${intent.description}"`;
  if (intent.semantic !== undefined) return `semantic=${intent.semantic}`;
  if (intent.role !== undefined) return `role=${intent.role}`;
  return '<empty intent>';
}
