/**
 * Heuristics that detect unstable selector ingredients.
 *
 * Kept next to the selector model rather than in the worker so that both the
 * locator scorer and the live workspace's "stability" column apply exactly the
 * same rules to the same string.
 */

/** Hashes and counters that change between builds or renders. */
const DYNAMIC_ID_PATTERNS: readonly RegExp[] = [
  /^[a-f0-9]{8,}$/i, // bare hash
  /^\d+$/, // pure counter
  /[-_:]\d{3,}$/, // trailing counter, e.g. field_12345
  /^(ember|react|ng|vue|mui|radix|headlessui|mat)[-_:]?\d+/i, // framework runtime ids
  /^:r[a-z0-9]+:$/i, // React 18 useId
  /[a-f0-9]{6,}-[a-f0-9]{4,}/i, // uuid fragment
];

/** CSS-module / utility-framework class names that carry no semantics. */
const GENERATED_CLASS_PATTERNS: readonly RegExp[] = [
  /^[a-z]+[-_][a-f0-9]{5,}$/i, // css-modules: button_1a2b3c
  /^css-[a-z0-9]{5,}$/i, // emotion
  /^sc-[a-zA-Z0-9]{6,}$/, // styled-components
  /^jsx-\d+$/, // styled-jsx
  /^[a-z0-9]{7,}$/i, // opaque hash-only class
];

const LONG_SELECTOR_THRESHOLD = 120;

export function isDynamicId(id: string): boolean {
  const trimmed = id.trim();
  if (trimmed.length === 0) return false;
  return DYNAMIC_ID_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isGeneratedClassName(className: string): boolean {
  const trimmed = className.trim();
  if (trimmed.length === 0) return false;
  // A readable, hyphenated name like `primary-button` is intentional.
  if (/^[a-z]+(-[a-z]+)+$/.test(trimmed)) return false;
  return GENERATED_CLASS_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function usesNthChild(selectorValue: string): boolean {
  return /:nth-(child|of-type)\(/i.test(selectorValue);
}

/** An XPath addressing elements purely by position breaks on any reorder. */
export function isPositionalXPath(xpath: string): boolean {
  const positionalSteps = xpath.match(/\[\d+\]/g)?.length ?? 0;
  return positionalSteps >= 2 || /^\/html(\/|$)/i.test(xpath);
}

export function isVeryLongSelector(selectorValue: string): boolean {
  return selectorValue.length > LONG_SELECTOR_THRESHOLD;
}

/** True when an id is stable enough to build a selector on. */
export function isStableId(id: string): boolean {
  return id.trim().length > 0 && !isDynamicId(id);
}
