import type { ScopedSelector, SelectorDefinition } from './selector-definition.js';

/**
 * Validation for selectors arriving from untrusted input — the live selector
 * editor, a submitted Test IR, a registry import.
 *
 * Blueprint rules 11 and 50: the selector editor must never become an
 * arbitrary code execution path. Because a SelectorDefinition is pure data and
 * the adapter maps it to typed Playwright calls, the main residual risk is a
 * CSS/XPath string smuggling in an expression or a pathological pattern. This
 * module rejects those before they reach any adapter.
 */

export const SELECTOR_LIMITS = {
  maxValueLength: 1024,
  maxWithinDepth: 8,
  maxNth: 500,
} as const;

/** Patterns rejected outright in raw CSS/XPath values. */
const DANGEROUS_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /javascript\s*:/i, reason: 'javascript: URL' },
  { pattern: /expression\s*\(/i, reason: 'legacy CSS expression()' },
  { pattern: /<\s*script/i, reason: 'inline script tag' },
  // Playwright treats these engines as executable selector extensions.
  { pattern: /\b_?react\s*=/i, reason: 'framework-internal selector engine' },
  { pattern: /\b_?vue\s*=/i, reason: 'framework-internal selector engine' },
  { pattern: /\bid\s*=\s*['"]?\s*\$\{/, reason: 'template interpolation' },
];

export interface SelectorValidationIssue {
  readonly path: string;
  readonly reason: string;
}

export type SelectorValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly SelectorValidationIssue[] };

export function validateSelectorDefinition(
  selector: SelectorDefinition,
  path = 'selector',
): SelectorValidation {
  const issues: SelectorValidationIssue[] = [];
  const values = collectValues(selector);

  for (const { field, value } of values) {
    const fieldPath = `${path}.${field}`;

    if (value.trim().length === 0) {
      issues.push({ path: fieldPath, reason: 'value must not be empty' });
      continue;
    }
    if (value.length > SELECTOR_LIMITS.maxValueLength) {
      issues.push({
        path: fieldPath,
        reason: `value exceeds ${SELECTOR_LIMITS.maxValueLength} characters`,
      });
    }
    if (value.includes('\u0000')) {
      issues.push({ path: fieldPath, reason: 'value contains a null byte' });
    }
    if (selector.type === 'css' || selector.type === 'xpath') {
      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(value)) {
          issues.push({ path: fieldPath, reason: `value contains a ${reason}` });
        }
      }
    }
  }

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

export function validateScopedSelector(scoped: ScopedSelector): SelectorValidation {
  const issues: SelectorValidationIssue[] = [];

  const root = validateSelectorDefinition(scoped.selector, 'selector');
  if (!root.valid) issues.push(...root.issues);

  const within = scoped.within ?? [];
  if (within.length > SELECTOR_LIMITS.maxWithinDepth) {
    issues.push({
      path: 'within',
      reason: `chain exceeds ${SELECTOR_LIMITS.maxWithinDepth} levels`,
    });
  }
  within.forEach((step, index) => {
    const result = validateSelectorDefinition(step, `within[${index}]`);
    if (!result.valid) issues.push(...result.issues);
  });

  if (scoped.nth !== undefined) {
    if (!Number.isInteger(scoped.nth) || scoped.nth < 0) {
      issues.push({ path: 'nth', reason: 'nth must be a non-negative integer' });
    } else if (scoped.nth > SELECTOR_LIMITS.maxNth) {
      issues.push({ path: 'nth', reason: `nth exceeds ${SELECTOR_LIMITS.maxNth}` });
    }
  }

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

function collectValues(selector: SelectorDefinition): { field: string; value: string }[] {
  switch (selector.type) {
    case 'role': {
      const values = [{ field: 'role', value: selector.role }];
      if (selector.name !== undefined) values.push({ field: 'name', value: selector.name });
      return values;
    }
    default:
      return [{ field: 'value', value: selector.value }];
  }
}
