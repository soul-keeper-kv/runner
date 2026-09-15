import type { RegistryMatch, RegistryPort } from '@runner/application';
import type { ElementIntent } from '@runner/domain';
import { lookupFromIntent } from '@runner/domain';
import type { ElementRegistryItem } from '@runner/registry-model';
import { ok, type Logger, type Result } from '@runner/shared';

/**
 * Registry-backed element lookup (blueprint sections 16 and 17).
 *
 * Resolution order, strongest first: stable ID, then user display name, then
 * alias, then system name, then description. The ordering is the point — a
 * stable ID survives renames, and a user-authored name outranks anything the
 * system guessed.
 *
 * The scoring itself lives in `@runner/registry-model` so that the API's search
 * endpoint and this lookup can never disagree about what counts as a match.
 * This class adds only what a *resolver* needs on top of that: a single best
 * answer, and a confidence floor below which it prefers to say nothing.
 */

/**
 * Below this, a registry match is too weak to resolve against.
 *
 * A near-miss is worse than a miss here: the resolver would skip DOM discovery
 * and act on a stored selector for a different element. Matching the resolver's
 * own `MIN_INTENT_SIMILARITY` keeps the two consistent.
 */
const MIN_REGISTRY_MATCH_SCORE = 0.4;

export class RegistryService {
  constructor(
    private readonly registry: RegistryPort,
    private readonly logger: Logger,
  ) {}

  /**
   * The best registry element for an intent, or undefined when none is good
   * enough.
   *
   * `undefined` is a normal answer, not a failure: it means "the Registry does
   * not know this element yet", and the caller falls through to DOM discovery.
   * Only a genuine lookup failure returns an error.
   */
  async findByIntent(
    workspaceRef: string,
    intent: ElementIntent,
  ): Promise<Result<ElementRegistryItem | undefined>> {
    const matches = await this.registry.findElements(lookupFromIntent(workspaceRef, intent));
    if (!matches.ok) return matches;

    const best = matches.value[0];
    if (best === undefined) return ok(undefined);

    // An id lookup is exact, so it is trusted regardless of score; a textual
    // match has to clear the floor.
    const exact = best.matchedOn === 'ID';
    if (!exact && best.matchScore < MIN_REGISTRY_MATCH_SCORE) {
      this.logger.debug('Registry match too weak to use', {
        workspaceRef,
        matchedOn: best.matchedOn,
        confidence: best.matchScore,
      });
      return ok(undefined);
    }

    this.logger.debug('Registry resolved an intent', {
      workspaceRef,
      elementId: best.element.id,
      matchedOn: best.matchedOn,
      confidence: best.matchScore,
    });
    return ok(best.element);
  }

  /**
   * Every candidate above the floor, strongest first.
   *
   * Used where a human or a model is going to choose — the live workspace
   * offering alternatives, and later the AI reranker, which must be handed a
   * shortlist rather than left to search.
   */
  async findCandidates(
    workspaceRef: string,
    intent: ElementIntent,
    limit = 5,
  ): Promise<Result<RegistryMatch[]>> {
    const matches = await this.registry.findElements({
      ...lookupFromIntent(workspaceRef, intent),
      limit,
    });
    if (!matches.ok) return matches;

    return ok(
      matches.value.filter(
        (match) => match.matchedOn === 'ID' || match.matchScore >= MIN_REGISTRY_MATCH_SCORE,
      ),
    );
  }
}
