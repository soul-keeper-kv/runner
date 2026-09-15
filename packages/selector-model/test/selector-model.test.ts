import { describe, expect, it } from 'vitest';
import {
  bonus,
  computeScore,
  describeScopedSelector,
  describeSelector,
  isDynamicId,
  isGeneratedClassName,
  isPositionalXPath,
  isStableId,
  penalty,
  selectorsEqual,
  stabilityOfScore,
  usesNthChild,
  validateScopedSelector,
  validateSelectorDefinition,
  type SelectorDefinition,
} from '../src/index.js';

describe('describeSelector', () => {
  it('renders every strategy unambiguously', () => {
    expect(describeSelector({ type: 'testId', value: 'login' })).toBe('testId=login');
    expect(describeSelector({ type: 'role', role: 'button', name: 'Login' })).toBe(
      'role=button[name="Login"]',
    );
    expect(describeSelector({ type: 'role', role: 'button' })).toBe('role=button');
    expect(describeSelector({ type: 'xpath', value: '//button' })).toBe('xpath=//button');
  });

  it('renders chained and framed selectors', () => {
    const description = describeScopedSelector({
      selector: { type: 'testId', value: 'customer-table' },
      within: [{ type: 'role', role: 'button', name: 'Edit' }],
      frameId: 'frame-1',
      nth: 2,
    });
    expect(description).toBe(
      'frame(frame-1) testId=customer-table >> role=button[name="Edit"] >> nth=2',
    );
  });

  it('treats structurally identical selectors as equal', () => {
    const a: SelectorDefinition = { type: 'testId', value: 'login' };
    const b: SelectorDefinition = { type: 'testId', value: 'login' };
    expect(selectorsEqual(a, b)).toBe(true);
    expect(selectorsEqual(a, { type: 'css', value: 'login' })).toBe(false);
  });
});

describe('scoring', () => {
  it('ranks test ids above roles above css above xpath', () => {
    const testId = computeScore('testId').score;
    const role = computeScore('role').score;
    const css = computeScore('css').score;
    const xpath = computeScore('xpath').score;
    expect(testId).toBeGreaterThan(role);
    expect(role).toBeGreaterThan(css);
    expect(css).toBeGreaterThan(xpath);
  });

  it('applies penalties and clamps to the 0..100 range', () => {
    const result = computeScore('css', [penalty('nonUnique'), penalty('nthChild')]);
    expect(result.baseScore).toBe(60);
    expect(result.score).toBe(0);
  });

  it('lets a user confirmation lift a weak selector', () => {
    const withoutConfirmation = computeScore('css').score;
    const withConfirmation = computeScore('css', [bonus('userConfirmed')]).score;
    expect(withConfirmation).toBeGreaterThan(withoutConfirmation);
  });

  it('maps scores to stability bands', () => {
    expect(stabilityOfScore(98)).toBe('HIGH');
    expect(stabilityOfScore(70)).toBe('MEDIUM');
    expect(stabilityOfScore(15)).toBe('LOW');
  });
});

describe('heuristics', () => {
  it('detects dynamic ids', () => {
    expect(isDynamicId('a1b2c3d4e5')).toBe(true);
    expect(isDynamicId('ember1234')).toBe(true);
    expect(isDynamicId(':r1a:')).toBe(true);
    expect(isDynamicId('field_12345')).toBe(true);
    expect(isDynamicId('login-button')).toBe(false);
    expect(isStableId('login-button')).toBe(true);
  });

  it('detects generated class names but keeps readable ones', () => {
    expect(isGeneratedClassName('css-1q2w3e4')).toBe(true);
    expect(isGeneratedClassName('sc-bdVaJa')).toBe(true);
    expect(isGeneratedClassName('primary-button')).toBe(false);
  });

  it('flags positional selectors', () => {
    expect(usesNthChild('div:nth-child(3)')).toBe(true);
    expect(isPositionalXPath('/html/body/div[3]/span[2]')).toBe(true);
    expect(isPositionalXPath('//button[@data-testid="login"]')).toBe(false);
  });
});

describe('selector guard', () => {
  it('accepts ordinary selectors', () => {
    expect(validateSelectorDefinition({ type: 'testId', value: 'login' }).valid).toBe(true);
    expect(validateSelectorDefinition({ type: 'role', role: 'button', name: 'Login' }).valid).toBe(
      true,
    );
  });

  it('rejects empty values', () => {
    const result = validateSelectorDefinition({ type: 'css', value: '   ' });
    expect(result.valid).toBe(false);
  });

  it('rejects code-execution attempts in raw css/xpath', () => {
    const injected = validateSelectorDefinition({
      type: 'css',
      value: 'a[href="javascript:alert(1)"]',
    });
    expect(injected.valid).toBe(false);

    const engine = validateSelectorDefinition({ type: 'css', value: '_react=Foo[bar=1]' });
    expect(engine.valid).toBe(false);
  });

  it('allows the same text in a non-raw strategy where it is inert', () => {
    expect(validateSelectorDefinition({ type: 'text', value: 'javascript: guide' }).valid).toBe(
      true,
    );
  });

  it('rejects an over-deep chain and a negative nth', () => {
    const deep = Array.from({ length: 9 }, () => ({ type: 'css', value: 'div' }) as const);
    const result = validateScopedSelector({
      selector: { type: 'css', value: 'body' },
      within: deep,
      nth: -1,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(['within', 'nth']),
      );
    }
  });
});
