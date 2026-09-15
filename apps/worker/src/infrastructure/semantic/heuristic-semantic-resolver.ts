import type {
  SemanticRanking,
  SemanticResolutionResult,
  SemanticResolverPort,
} from '@runner/application';
import type { ElementCandidate, ElementIntent } from '@runner/domain';
import { labelOf } from '@runner/domain';
import type { ElementRegistryItem } from '@runner/registry-model';
import { ok, type Clock, type Logger, type Result } from '@runner/shared';

/**
 * A semantic resolver that reranks a shortlist on *context* rather than labels
 * (blueprint section 45).
 *
 * This is the AI seam made real without a model. It exists because the port's
 * value is not "call an LLM" — it is "rerank a shortlist using signals the
 * deterministic pass ignores, and explain the choice". Those signals are already
 * in the snapshot: the text around an element, the form and component it sits
 * in, the landmark above it. A label-similarity pass throws all of that away.
 *
 * Three constraints the blueprint puts on this boundary are honoured here and
 * are the reason the class is shaped this way:
 *
 *  - **It only ranks.** It receives candidates and returns scores. It cannot
 *    navigate, execute, or write to the Registry, because it is handed neither a
 *    browser nor a registry.
 *  - **It runs last.** Deterministic resolution decides first; this is consulted
 *    only when that has already failed. If AI starts looking like the fix for
 *    ordinary resolution, the bug is in scoring or filtering — fix that instead.
 *  - **It explains itself.** Every ranking carries `reasoning`, because a
 *    resolution a reviewer cannot audit is worse than a failure they can.
 *
 * An LLM-backed adapter implements the same port and replaces this binding in
 * the composition root. Nothing above the port changes — which is the whole
 * point of the port existing before any model does.
 */

export interface HeuristicSemanticResolverOptions {
  /** Below this, no ranking is offered at all. */
  readonly minScore?: number;
  /** Refuse an oversized shortlist rather than scoring a whole page. */
  readonly maxCandidates?: number;
}

/**
 * Weights, calibrated against real scores rather than chosen by feel.
 *
 * The first cut used 0.25/0.30/0.25 with a 0.35 floor, and measuring it showed
 * the arithmetic could not reach that floor: an *exact* label match scored 0.25,
 * and a candidate needed three coinciding signals to pass at all. Every
 * context case returned no ranking.
 *
 * So a full label match now clears the floor on its own — that is the one case
 * where the label should dominate — while context stays the strongest
 * *discriminator*, because separating two identically-labelled controls is this
 * resolver's whole reason to exist.
 */
const WEIGHT_LABEL = 0.45;
const WEIGHT_CONTEXT = 0.35;
/*
 * Hints and landmarks are *structural* evidence — a developer named that form,
 * that component, that landmark — so a half-matching label plus one of them
 * clears the floor. Measurement drove these: at 0.25/0.15 a `formHint` match
 * scored 0.35 and a landmark match 0.375, both just under the bar, which meant
 * the two signals this resolver exists to exploit could never decide anything.
 */
const WEIGHT_HINTS = 0.35;
const WEIGHT_LANDMARK = 0.25;
const WEIGHT_ROLE = 0.1;
/** A mapping a person confirmed is the best evidence available. */
const WEIGHT_REGISTRY_CONFIRMED = 0.35;
const WEIGHT_REGISTRY = 0.2;

/**
 * A single convincing signal passes; noise does not.
 *
 * 0.4 sits above a half-matching label alone (0.225) and below a full label
 * match (0.45) or a half-match plus any real context signal.
 */
const DEFAULT_MIN_SCORE = 0.4;
const DEFAULT_MAX_CANDIDATES = 20;

export class HeuristicSemanticResolver implements SemanticResolverPort {
  readonly available = true;

  private readonly minScore: number;
  private readonly maxCandidates: number;

  constructor(
    private readonly logger: Logger,
    private readonly clock: Clock,
    options: HeuristicSemanticResolverOptions = {},
  ) {
    this.minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  }

  async rankElements(input: {
    readonly intent: ElementIntent;
    readonly candidates: readonly ElementCandidate[];
    readonly registryCandidates: readonly ElementRegistryItem[];
    readonly pageUrl?: string;
  }): Promise<Result<SemanticResolutionResult>> {
    const startedAt = this.clock.now();

    // A shortlist, not a page. Deterministic filtering is supposed to have
    // narrowed this already; scoring a hundred elements here would mean that
    // filtering is not doing its job.
    const candidates = input.candidates.slice(0, this.maxCandidates);

    const rankings = candidates
      .map((candidate) => this.rankOne(input.intent, candidate, input.registryCandidates))
      .filter((ranking): ranking is SemanticRanking => ranking !== undefined)
      .sort((a, b) => b.score - a.score);

    this.logger.debug('Semantic reranking complete', {
      candidates: candidates.length,
      ranked: rankings.length,
    });

    return ok({
      rankings,
      modelRef: 'heuristic-context-v1',
      latencyMs: this.clock.now() - startedAt,
    });
  }

  /**
   * Scores one candidate on the signals a label comparison cannot see.
   *
   * Each contribution is additive and named, so the `reasoning` string is
   * assembled from the same facts that produced the number — a score and an
   * explanation that can disagree is worse than no explanation.
   */
  private rankOne(
    intent: ElementIntent,
    candidate: ElementCandidate,
    registryCandidates: readonly ElementRegistryItem[],
  ): SemanticRanking | undefined {
    const wanted = tokensOf(`${intent.name ?? ''} ${intent.description ?? ''}`);
    if (wanted.length === 0) return undefined;

    const reasons: string[] = [];
    let score = 0;

    // The element's own label. Weighted lowest on purpose: the deterministic
    // pass already tried this and came up short, which is why we are here.
    const labelOverlap = overlap(wanted, tokensOf(labelOf(candidate)));
    if (labelOverlap > 0) {
      score += labelOverlap * WEIGHT_LABEL;
      reasons.push(`label shares ${percent(labelOverlap)} of the intent's words`);
    }

    // Surrounding text: a "Submit" button inside a "Shipping address" panel is
    // the shipping submit, and only the context says so.
    const contextText = [
      candidate.context?.parentText,
      ...(candidate.context?.nearbyText ?? []),
    ]
      .filter((value): value is string => value !== undefined)
      .join(' ');
    const contextOverlap = overlap(wanted, tokensOf(contextText));
    if (contextOverlap > 0) {
      score += contextOverlap * WEIGHT_CONTEXT;
      reasons.push(`surrounding text shares ${percent(contextOverlap)} of the intent's words`);
    }

    // Component and form hints are authored names — a developer called that
    // subtree something, and it usually means what it says.
    const hintOverlap = overlap(
      wanted,
      tokensOf(`${candidate.context?.componentHint ?? ''} ${candidate.context?.formHint ?? ''}`),
    );
    if (hintOverlap > 0) {
      score += hintOverlap * WEIGHT_HINTS;
      reasons.push('component or form name matches the intent');
    }

    // A landmark mentioned by the intent ("the dialog's Save") is a strong
    // disambiguator between otherwise identical controls.
    const landmark = candidate.context?.landmark;
    if (landmark !== undefined && wanted.includes(landmark.toLowerCase())) {
      score += WEIGHT_LANDMARK;
      reasons.push(`sits inside the ${landmark} landmark the intent mentions`);
    }

    if (intent.role !== undefined && candidate.role === intent.role) {
      score += WEIGHT_ROLE;
      reasons.push(`role matches ${intent.role}`);
    }

    // A registry element that a human confirmed, whose name matches, is the best
    // evidence available — better than anything read off the page.
    const registryMatch = registryCandidates.find(
      (element) => overlap(wanted, tokensOf(element.displayName)) > 0.5,
    );
    if (registryMatch !== undefined) {
      score += registryMatch.userConfirmed ? WEIGHT_REGISTRY_CONFIRMED : WEIGHT_REGISTRY;
      reasons.push(
        registryMatch.userConfirmed
          ? `matches "${registryMatch.displayName}", a mapping a person confirmed`
          : `matches the registry element "${registryMatch.displayName}"`,
      );
    }

    const bounded = Math.min(1, Math.round(score * 1000) / 1000);
    if (bounded < this.minScore) return undefined;

    const ranking: Record<string, unknown> = {
      runtimeId: candidate.runtimeId,
      score: bounded,
      reasoning: reasons.join('; '),
    };
    if (registryMatch !== undefined) ranking.elementId = registryMatch.id;

    return ranking as unknown as SemanticRanking;
  }
}

/** Words that carry no discriminating power, matching the locator engine's set. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'for',
  'and',
  'or',
  'button',
  'field',
  'input',
  'link',
  'icon',
]);

function tokensOf(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** Fraction of `wanted` present in `found`, 0..1. */
function overlap(wanted: readonly string[], found: readonly string[]): number {
  if (wanted.length === 0 || found.length === 0) return 0;

  const haystack = new Set(found);
  const shared = wanted.filter((token) => haystack.has(token)).length;
  return Math.round((shared / wanted.length) * 1000) / 1000;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
