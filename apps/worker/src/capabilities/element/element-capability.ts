import type { BrowserPort, RegistryPort } from '@runner/application';
import type { ElementCandidate } from '@runner/domain';
import { labelOf } from '@runner/domain';
import type {
  ElementDescribePayload,
  ElementHighlightPayload,
  LiveCommandType,
  PickedElementSnapshot,
  RawLiveCommand,
} from '@runner/live-protocol';
import {
  selectorsEqual,
  validateSelectorDefinition,
  type SelectorDefinition,
} from '@runner/selector-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';
import {
  payloadOf,
  type LiveCapability,
  type LiveSessionContext,
} from '../capability-registry.js';
import {
  DefaultLocatorGenerator,
  type LocatorGenerator,
} from '../../modules/locator/locator-generator.js';
import {
  DefaultLocatorValidator,
  type LocatorValidator,
} from '../../modules/locator/locator-validator.js';

/**
 * Element inspection and picking (blueprint sections 33 and 34).
 *
 * This closes the authoring loop. The workspace shows a frame, the user clicks
 * the thing they mean, and the Runner answers with that element already
 * described and its selectors ranked and validated against the live page — so
 * the name a human gives it is the only thing left to supply.
 *
 * Two decisions worth keeping:
 *
 *  - Picking is **coordinate-based**, not selector-based. The client sends the
 *    point it was clicked at; it never constructs a selector. Selector
 *    construction stays on the worker, where the scoring rules and the page
 *    both live.
 *  - Candidate selectors are **validated before being offered**, so a
 *    `matchCount` of 3 is visible at pick time rather than discovered later by
 *    a run that clicked the wrong row.
 */

/** How many ranked selectors are probed against the page per pick. */
const MAX_SELECTORS_TO_VALIDATE = 5;

export class ElementCapability implements LiveCapability<PickedElementSnapshot | { picking: boolean }> {
  readonly type = 'element' as const;
  readonly handles: readonly LiveCommandType[] = [
    'element.describe',
    'element.highlight',
    'element.pick.start',
    'element.pick.cancel',
  ];

  constructor(
    private readonly generator: LocatorGenerator = new DefaultLocatorGenerator(),
    private readonly validator: LocatorValidator = new DefaultLocatorValidator(),
    /**
     * Optional: when present, a picked element is matched against the Registry
     * so the client can tell "new element" from "one you already named".
     */
    private readonly registry?: RegistryPort,
  ) {}

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<PickedElementSnapshot | { picking: boolean }>> {
    switch (command.type as LiveCommandType) {
      case 'element.describe':
        return this.describe(command, context);
      case 'element.highlight':
        return this.highlight(command, context);

      /*
       * Pick mode is a *client* state in this build.
       *
       * The frame is a screenshot, so the workspace already knows where the user
       * clicked and simply sends `element.describe` with that point. There is no
       * click interception to install in the page — which is the honest answer
       * rather than injecting a listener that would alter the page under test.
       * These two commands exist so a client can announce the mode and have the
       * session agree it is supported.
       */
      case 'element.pick.start':
        context.logger.debug('Pick mode started');
        return ok({ picking: true });
      case 'element.pick.cancel':
        context.logger.debug('Pick mode cancelled');
        return ok({ picking: false });

      default:
        return err(RunnerErrors.liveCommandUnsupported(command.type));
    }
  }

  /**
   * Describes the element a user pointed at, with ranked, validated selectors.
   */
  private async describe(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<PickedElementSnapshot>> {
    const payload = payloadOf<ElementDescribePayload>(command);
    if (!payload.ok) return payload;

    const candidate = await this.resolveCandidate(payload.value, context.browser);
    if (!candidate.ok) return candidate;

    const selectors = await this.rankSelectors(candidate.value, context.browser);

    const snapshot: Record<string, unknown> = {
      runtimeId: candidate.value.runtimeId,
      tag: candidate.value.tag,
      attributes: candidate.value.attributes,
      candidateSelectors: selectors,
    };

    if (candidate.value.role !== undefined) snapshot.role = candidate.value.role;
    const name = candidate.value.accessibleName ?? labelOf(candidate.value);
    if (name !== candidate.value.tag) snapshot.accessibleName = name;
    if (candidate.value.text !== undefined) snapshot.text = candidate.value.text;
    if (candidate.value.bbox !== undefined) snapshot.bbox = candidate.value.bbox;

    // Phase 10: tell the client whether this element is already known. Absent
    // when nothing matches well enough — a guess here would show a link to an
    // element nobody confirmed, which is worse than silence.
    const matched = await this.matchRegistry(candidate.value, selectors, context);
    if (matched !== undefined) snapshot.matchedElementId = matched;

    context.logger.debug('Element described', {
      tag: candidate.value.tag,
      selectorCount: selectors.length,
    });

    return ok(snapshot as unknown as PickedElementSnapshot);
  }

  /**
   * The Registry element this pick corresponds to, if any.
   *
   * Matched by accessible name through the same scoring the Registry's own
   * search uses, so picking an element the user already named reports that id
   * rather than inviting a duplicate entry. A lookup failure is swallowed: the
   * pick itself is still a valid answer, and the client simply treats the
   * element as new.
   */
  private async matchRegistry(
    candidate: ElementCandidate,
    selectors: readonly { selector: SelectorDefinition }[],
    context: LiveSessionContext,
  ): Promise<string | undefined> {
    if (this.registry === undefined) return undefined;

    const workspaceRef = context.session.workspaceRef;

    /*
     * Selector identity first, name second.
     *
     * Matching only by name meant "already known" worked precisely when it was
     * least useful: the user names an element for what it *means* ("Sign In
     * Field") while the DOM label says what it *shows* ("Email"), so the two
     * score zero against each other and a saved element looked new on the next
     * pick. The stored `primarySelector` is how the element is identified
     * mechanically, so comparing that recognizes it regardless of naming.
     */
    const scoped = await this.registry.findElements({ workspaceRef });
    if (!scoped.ok) {
      context.logger.debug('Registry lookup failed during a pick', {
        errorCode: scoped.error.code,
      });
      return undefined;
    }

    for (const match of scoped.value) {
      const stored = match.element.primarySelector;
      if (selectors.some((entry) => selectorsEqual(entry.selector, stored))) {
        return match.element.id;
      }
    }

    // No selector matched, so fall back to the element's own label. This catches
    // the case where a selector has since been healed but the meaning is the
    // same, and it uses the Registry's own scoring so the floor is consistent
    // with the resolver and the registry service.
    const name = candidate.accessibleName ?? labelOf(candidate);
    if (name === candidate.tag) return undefined;

    const byName = await this.registry.findElements({ workspaceRef, name, limit: 1 });
    if (!byName.ok) return undefined;

    const best = byName.value[0];
    return best !== undefined && best.matchScore >= 0.4 ? best.element.id : undefined;
  }

  /** Point, then selector, then runtimeId — strongest available form first. */
  private async resolveCandidate(
    payload: ElementDescribePayload,
    browser: BrowserPort,
  ): Promise<Result<ElementCandidate>> {
    if (payload.point !== undefined) {
      return browser.describeElementAtPoint(payload.point.x, payload.point.y);
    }

    if (payload.selector !== undefined) {
      const validation = validateSelectorDefinition(payload.selector);
      if (!validation.valid) {
        return err(
          RunnerErrors.selectorInvalid(
            payload.selector.type,
            validation.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('; '),
          ),
        );
      }
      return browser.describeElement({ selector: payload.selector });
    }

    if (payload.runtimeId !== undefined) {
      // A runtimeId identifies an element within one snapshot only, and nothing
      // maps it back to a live node once the page has moved on. Saying so beats
      // resolving the wrong element with confidence.
      return err(
        RunnerErrors.validationFailed(
          'A runtimeId cannot be resolved on its own; send `point` or `selector` instead.',
          { runtimeId: payload.runtimeId },
        ),
      );
    }

    return err(
      RunnerErrors.validationFailed('element.describe needs `point` or `selector`.'),
    );
  }

  /**
   * Generates selectors for the element and probes each against the page.
   *
   * The `matchCount` is the point: a `data-testid` that happens to appear three
   * times looks perfect on paper, and a user picking an element deserves to see
   * that before they save it.
   */
  private async rankSelectors(
    candidate: ElementCandidate,
    browser: BrowserPort,
  ): Promise<{ selector: SelectorDefinition; score: number; matchCount: number }[]> {
    const generated = this.generator.generate(candidate).slice(0, MAX_SELECTORS_TO_VALIDATE);
    const ranked: { selector: SelectorDefinition; score: number; matchCount: number }[] = [];

    for (const entry of generated) {
      const validated = await this.validator.validate(browser, { selector: entry.selector });

      ranked.push({
        selector: entry.selector,
        score: entry.score,
        // A selector that could not be evaluated reports zero rather than being
        // dropped, so the client sees every option that was considered.
        matchCount: validated.ok ? validated.value.matchCount : 0,
      });
    }

    // Unique matches first, then by score: a weaker selector that resolves
    // uniquely is more useful than a strong one that matches five elements.
    return ranked.sort((a, b) => {
      const aUnique = a.matchCount === 1 ? 0 : 1;
      const bUnique = b.matchCount === 1 ? 0 : 1;
      return aUnique - bUnique || b.score - a.score;
    });
  }

  private async highlight(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<PickedElementSnapshot | { picking: boolean }>> {
    const payload = payloadOf<ElementHighlightPayload>(command);
    if (!payload.ok) return payload;

    const { selector, durationMs } = payload.value;
    if (selector === undefined) {
      // Highlighting by elementId needs the Registry to supply the selector,
      // which is Phase 10.
      return err(
        RunnerErrors.validationFailed('element.highlight needs a `selector` in this build.'),
      );
    }

    const validation = validateSelectorDefinition(selector);
    if (!validation.valid) {
      return err(
        RunnerErrors.selectorInvalid(
          selector.type,
          validation.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('; '),
        ),
      );
    }

    const highlighted = await context.browser.highlight({ selector }, durationMs);
    if (!highlighted.ok) return highlighted;

    return ok({ picking: false });
  }
}
