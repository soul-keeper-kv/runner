import { describe, expect, it } from 'vitest';
import {
  MATCH_KIND_WEIGHTS,
  matchElementByName,
  nameSimilarity,
  normalizeName,
  splitSystemName,
  type ElementRegistryItem,
} from '../src/index.js';

function elementWith(overrides: Partial<ElementRegistryItem> = {}): ElementRegistryItem {
  return {
    id: 'el_1',
    workspaceRef: 'workspace_checkout',
    systemName: 'createCustomerButton',
    displayName: 'Create Customer Button',
    displayNameSource: 'USER',
    aliases: [],
    primarySelector: { type: 'testId', value: 'create-customer' },
    fallbackSelectors: [],
    userConfirmed: false,
    confidence: 0.8,
    selectorHistory: [],
    namingHistory: [],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeName', () => {
  it('strips diacritics so a Vietnamese label matches its unaccented form', () => {
    expect(normalizeName('Ô Nhập Tên')).toBe('o nhap ten');
    expect(normalizeName('Đăng nhập')).toBe('ang nhap');
  });

  it('collapses punctuation and whitespace', () => {
    expect(normalizeName('  Sign-in / Login!  ')).toBe('sign in login');
  });
});

describe('nameSimilarity', () => {
  it('scores an exact match, case and spacing aside, as certainty', () => {
    expect(nameSimilarity('Login Button', '  login   button ')).toBe(1);
  });

  it('normalizes its own input, so callers cannot get it wrong', () => {
    // Regression guard: the worker's equivalent once assumed pre-normalized
    // input and silently scored 0 for accented labels.
    expect(nameSimilarity('Ô Nhập Tên', 'o nhap ten')).toBe(1);
  });

  it('rewards a substring match even when token counts differ', () => {
    expect(nameSimilarity('Login', 'Login Button')).toBeGreaterThan(0);
  });

  it('scores unrelated labels at zero', () => {
    expect(nameSimilarity('Login', 'Postal Code')).toBe(0);
  });

  it('ignores words that carry no meaning in a UI label', () => {
    // "Button" is a stop word, so these differ only by noise.
    expect(nameSimilarity('Create Customer Button', 'Create Customer')).toBe(1);
  });

  it('returns zero for empty input rather than throwing', () => {
    expect(nameSimilarity('', 'Login')).toBe(0);
    expect(nameSimilarity('Login', '')).toBe(0);
  });
});

describe('splitSystemName', () => {
  it('makes a camelCase identifier comparable to human text', () => {
    expect(splitSystemName('createCustomerButton')).toBe('create Customer Button');
  });
});

describe('matchElementByName', () => {
  it('prefers a display name over an alias for the same query', () => {
    const match = matchElementByName(
      elementWith({
        aliases: [
          { value: 'Create Customer Button', source: 'AI', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
      'Create Customer Button',
    );

    expect(match?.kind).toBe('DISPLAY_NAME');
  });

  it('finds an element by an alias a user taught it', () => {
    const match = matchElementByName(
      elementWith({
        displayName: 'Create Customer Button',
        aliases: [
          { value: 'Save Customer', source: 'USER', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
      'Save Customer',
    );

    expect(match?.kind).toBe('ALIAS');
    expect(match?.matchedText).toBe('Save Customer');
    expect(match?.source).toBe('USER');
  });

  it('resolves a system name back to human words', () => {
    const match = matchElementByName(
      elementWith({ displayName: 'Totally Unrelated', systemName: 'postalCodeField' }),
      'Postal Code',
    );

    expect(match?.kind).toBe('SYSTEM_NAME');
  });

  it('matches on description only as a last resort', () => {
    const match = matchElementByName(
      elementWith({
        displayName: 'Unrelated Name',
        systemName: 'unrelatedName',
        description: 'Creates a new customer from the form',
      }),
      'Creates a new customer from the form',
    );

    expect(match?.kind).toBe('DESCRIPTION');
    // A description hit must never outrank a real name hit.
    expect(match!.score).toBeLessThan(MATCH_KIND_WEIGHTS.DISPLAY_NAME);
  });

  it('returns nothing for a query that matches no name', () => {
    expect(matchElementByName(elementWith(), 'Shipping Address')).toBeUndefined();
  });

  it('returns nothing for an empty query rather than matching everything', () => {
    expect(matchElementByName(elementWith(), '   ')).toBeUndefined();
  });

  it('ranks a stronger textual match above a weaker one', () => {
    const exact = matchElementByName(elementWith(), 'Create Customer Button');
    const partial = matchElementByName(elementWith(), 'Create');

    expect(exact!.score).toBeGreaterThan(partial!.score);
  });
});
