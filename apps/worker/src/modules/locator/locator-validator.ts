import type { BrowserPort } from '@runner/application';
import type { ScopedSelector, SelectorDefinition } from '@runner/selector-model';
import { describeSelector } from '@runner/selector-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';

/**
 * Checks a candidate selector against the live page before it is used
 * (blueprint section 15).
 *
 * The three outcomes are not interchangeable and the Runner must keep them
 * apart: zero matches means the selector is wrong or the element is not there
 * yet; exactly one means it is usable; more than one means it is *ambiguous*,
 * which is more dangerous than failing outright — silently acting on the first
 * of several matches is how an automated run clicks the wrong row.
 */

export type ValidationOutcome = 'VALID' | 'NO_MATCH' | 'AMBIGUOUS' | 'NOT_INTERACTABLE';

export interface SelectorValidationResult {
  readonly outcome: ValidationOutcome;
  readonly matchCount: number;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly bbox?: { x: number; y: number; width: number; height: number };
  readonly reason: string;
}

export interface ValidationExpectations {
  /** Require the element to be visible and enabled, as an action would. */
  readonly requireInteractable?: boolean;
  readonly requireEditable?: boolean;
  readonly expectedRole?: string;
}

export interface LocatorValidator {
  validate(
    browser: BrowserPort,
    selector: ScopedSelector,
    expectations?: ValidationExpectations,
  ): Promise<Result<SelectorValidationResult>>;

  findFirstValid(
    browser: BrowserPort,
    selectors: readonly SelectorDefinition[],
    expectations?: ValidationExpectations,
  ): Promise<
    Result<{ selector: SelectorDefinition; validation: SelectorValidationResult }>
  >;
}

export class DefaultLocatorValidator implements LocatorValidator {
  async validate(
    browser: BrowserPort,
    selector: ScopedSelector,
    expectations: ValidationExpectations = {},
  ): Promise<Result<SelectorValidationResult>> {
    const probed = await browser.probe(selector);
    if (!probed.ok) return probed;

    const info = probed.value;

    if (info.matchCount === 0) {
      return ok({
        outcome: 'NO_MATCH',
        matchCount: 0,
        visible: false,
        enabled: false,
        editable: false,
        reason: 'selector matched no elements',
      });
    }

    if (info.matchCount > 1) {
      return ok({
        outcome: 'AMBIGUOUS',
        matchCount: info.matchCount,
        visible: info.visible,
        enabled: info.enabled,
        editable: info.editable,
        ...(info.bbox === undefined ? {} : { bbox: info.bbox }),
        reason: `selector matched ${info.matchCount} elements; expected exactly one`,
      });
    }

    if (expectations.requireInteractable === true && !(info.visible && info.enabled)) {
      return ok({
        outcome: 'NOT_INTERACTABLE',
        matchCount: 1,
        visible: info.visible,
        enabled: info.enabled,
        editable: info.editable,
        ...(info.bbox === undefined ? {} : { bbox: info.bbox }),
        reason: info.visible ? 'element is visible but disabled' : 'element is not visible',
      });
    }

    if (expectations.requireEditable === true && !info.editable) {
      return ok({
        outcome: 'NOT_INTERACTABLE',
        matchCount: 1,
        visible: info.visible,
        enabled: info.enabled,
        editable: false,
        ...(info.bbox === undefined ? {} : { bbox: info.bbox }),
        reason: 'element is not editable',
      });
    }

    if (
      expectations.expectedRole !== undefined &&
      info.role !== undefined &&
      info.role !== expectations.expectedRole
    ) {
      return ok({
        outcome: 'NOT_INTERACTABLE',
        matchCount: 1,
        visible: info.visible,
        enabled: info.enabled,
        editable: info.editable,
        ...(info.bbox === undefined ? {} : { bbox: info.bbox }),
        reason: `expected role "${expectations.expectedRole}" but found "${info.role}"`,
      });
    }

    return ok({
      outcome: 'VALID',
      matchCount: 1,
      visible: info.visible,
      enabled: info.enabled,
      editable: info.editable,
      ...(info.bbox === undefined ? {} : { bbox: info.bbox }),
      reason: 'selector uniquely matched 1 element',
    });
  }

  /**
   * Tries candidates in the order given and returns the first usable one.
   *
   * Ranked order matters: the caller has already sorted by score, so this walks
   * from most to least stable and stops as soon as the page agrees.
   */
  async findFirstValid(
    browser: BrowserPort,
    selectors: readonly SelectorDefinition[],
    expectations: ValidationExpectations = {},
  ): Promise<Result<{ selector: SelectorDefinition; validation: SelectorValidationResult }>> {
    const attempts: string[] = [];

    for (const selector of selectors) {
      const validated = await this.validate(browser, { selector }, expectations);
      if (!validated.ok) {
        attempts.push(`${describeSelector(selector)}: ${validated.error.message}`);
        continue;
      }

      if (validated.value.outcome === 'VALID') {
        return ok({ selector, validation: validated.value });
      }
      attempts.push(`${describeSelector(selector)}: ${validated.value.reason}`);
    }

    return err(
      RunnerErrors.elementNotFound('no candidate selector resolved uniquely', {
        attempts,
        candidateCount: selectors.length,
      }),
    );
  }
}
