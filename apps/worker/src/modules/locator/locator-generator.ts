import type { ElementCandidate } from '@runner/domain';
import { TEST_ID_ATTRIBUTES, testIdOf } from '@runner/domain';
import {
  computeScore,
  isDynamicId,
  isGeneratedClassName,
  isVeryLongSelector,
  penalty,
  selectorsEqual,
  type ScoreAdjustment,
  type ScoredSelector,
  type SelectorDefinition,
} from '@runner/selector-model';

/**
 * Generates every reasonable selector for one element candidate
 * (blueprint section 13).
 *
 * The rule this implements is "never rely on a single selector". A registry
 * entry keeps a primary plus ranked fallbacks, so when a `data-testid` is
 * renamed the role-and-name selector underneath it still resolves, and healing
 * has real alternatives to propose instead of guessing.
 *
 * Generation is deliberately separate from scoring and from validation:
 * generation is pure and browser-free, which is what makes the ranking rules
 * unit-testable before any page exists.
 */

export interface LocatorGenerator {
  generate(candidate: ElementCandidate): ScoredSelector[];
}

export class DefaultLocatorGenerator implements LocatorGenerator {
  generate(candidate: ElementCandidate): ScoredSelector[] {
    const scored: ScoredSelector[] = [];

    for (const { selector, adjustments } of this.candidateSelectors(candidate)) {
      // Deduplicate: several strategies can produce the same selector, e.g.
      // an accessible name that equals the element's text.
      if (scored.some((existing) => selectorsEqual(existing.selector, selector))) continue;

      const { score, baseScore } = computeScore(selector.type, adjustments);
      scored.push({ selector, score, baseScore, adjustments });
    }

    return scored.sort((a, b) => b.score - a.score);
  }

  private candidateSelectors(
    candidate: ElementCandidate,
  ): { selector: SelectorDefinition; adjustments: ScoreAdjustment[] }[] {
    const results: { selector: SelectorDefinition; adjustments: ScoreAdjustment[] }[] = [];
    const attributes = candidate.attributes;

    // --- test id: the most stable signal, because it exists for testing ---
    const testId = testIdOf(candidate);
    if (testId !== undefined) {
      results.push({ selector: { type: 'testId', value: testId }, adjustments: [] });
    }

    // --- role + accessible name: stable and semantic ---
    if (candidate.role !== undefined && candidate.accessibleName !== undefined) {
      results.push({
        selector: { type: 'role', role: candidate.role, name: candidate.accessibleName },
        adjustments: [],
      });
    }

    // --- label, placeholder, alt, title ---
    const label = attributes['aria-label'];
    if (label !== undefined) {
      results.push({ selector: { type: 'label', value: label }, adjustments: [] });
    }
    if (candidate.accessibleName !== undefined && label === undefined && candidate.editable) {
      results.push({
        selector: { type: 'label', value: candidate.accessibleName },
        adjustments: [],
      });
    }

    const placeholder = attributes.placeholder;
    if (placeholder !== undefined) {
      results.push({ selector: { type: 'placeholder', value: placeholder }, adjustments: [] });
    }

    const alt = attributes.alt;
    if (alt !== undefined) {
      results.push({ selector: { type: 'altText', value: alt }, adjustments: [] });
    }

    const title = attributes.title;
    if (title !== undefined) {
      results.push({ selector: { type: 'title', value: title }, adjustments: [] });
    }

    // --- text: readable, but breaks on copy changes and localization ---
    if (candidate.text !== undefined && candidate.text.length <= 60) {
      results.push({ selector: { type: 'text', value: candidate.text }, adjustments: [] });
    }

    // --- id: only worth it when the id looks authored, not generated ---
    const id = attributes.id;
    if (id !== undefined) {
      const adjustments = isDynamicId(id) ? [penalty('dynamicId', id)] : [];
      results.push({ selector: { type: 'css', value: `#${cssEscape(id)}` }, adjustments });
    }

    // --- name attribute: common and stable on form fields ---
    const name = attributes.name;
    if (name !== undefined) {
      results.push({
        selector: { type: 'css', value: `${candidate.tag}[name="${cssEscape(name)}"]` },
        adjustments: [],
      });
    }

    // --- a testId-attribute CSS form, for engines without getByTestId ---
    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = attributes[attribute];
      if (value !== undefined) {
        results.push({
          selector: {
            type: 'css',
            value: `${candidate.tag}[${attribute}="${cssEscape(value)}"]`,
          },
          adjustments: [],
        });
        break;
      }
    }

    // --- class-based CSS: last resort, and only for authored class names ---
    const classSelector = this.classSelector(candidate);
    if (classSelector !== undefined) results.push(classSelector);

    return results.map((entry) => ({
      selector: entry.selector,
      adjustments: [...entry.adjustments, ...this.lengthAdjustments(entry.selector)],
    }));
  }

  /**
   * Builds a class-based selector from semantic class names only.
   *
   * Hashed CSS-module and styled-components classes change on every build, so
   * including them would produce a selector that passes today and fails after
   * the next deploy — exactly the breakage self-healing exists to avoid.
   */
  private classSelector(
    candidate: ElementCandidate,
  ): { selector: SelectorDefinition; adjustments: ScoreAdjustment[] } | undefined {
    const classAttribute = candidate.attributes.class;
    if (classAttribute === undefined) return undefined;

    const classes = classAttribute.split(/\s+/).filter((name) => name.length > 0);
    const semantic = classes.filter((name) => !isGeneratedClassName(name));
    if (semantic.length === 0) return undefined;

    const chosen = semantic.slice(0, 2);
    const adjustments: ScoreAdjustment[] =
      semantic.length < classes.length
        ? [penalty('generatedClass', 'element also carries generated class names')]
        : [];

    return {
      selector: {
        type: 'css',
        value: `${candidate.tag}.${chosen.map(cssEscape).join('.')}`,
      },
      adjustments,
    };
  }

  private lengthAdjustments(selector: SelectorDefinition): ScoreAdjustment[] {
    const value = 'value' in selector ? selector.value : (selector.name ?? '');
    return isVeryLongSelector(value) ? [penalty('veryLongSelector')] : [];
  }
}

/**
 * Minimal CSS identifier escaping; sufficient for attribute and id values.
 *
 * The characters are listed explicitly rather than as a regex character class:
 * a class containing both `\` and `]` is easy to get subtly wrong, and a
 * mis-escaped class silently produces selectors that match the wrong thing.
 */
const CSS_SPECIAL_CHARS = new Set([
  '"',
  "'",
  '\\',
  ']',
  '[',
  '#',
  '.',
  ':',
  '>',
  '+',
  '~',
  '*',
  '^',
  '$',
  '|',
  '=',
  '(',
  ')',
  ' ',
]);

function cssEscape(value: string): string {
  let escaped = '';
  for (const char of value) {
    if (CSS_SPECIAL_CHARS.has(char)) escaped += '\\';
    escaped += char;
  }
  return escaped;
}
