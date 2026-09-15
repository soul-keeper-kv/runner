import { describe, expect, it } from 'vitest';
import type { BrowserPort, SemanticResolverPort } from '@runner/application';
import type { ElementCandidate, PageSnapshot } from '@runner/domain';
import { noopLogger, ok } from '@runner/shared';
import { DefaultLocatorGenerator } from '../src/modules/locator/locator-generator.js';
import { DefaultLocatorScorer } from '../src/modules/locator/locator-scorer.js';
import { DeterministicElementResolver } from '../src/modules/resolver/element-resolver.js';
import {
  filterBySemantics,
  filterInteractable,
  rankByTextSimilarity,
  similarity,
} from '../src/modules/inspector/candidate-filter.js';

function candidate(overrides: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    runtimeId: 'rt_1',
    tag: 'button',
    attributes: {},
    visible: true,
    enabled: true,
    editable: false,
    interactable: true,
    ...overrides,
  };
}

const generator = new DefaultLocatorGenerator();
const scorer = new DefaultLocatorScorer();

describe('locator generation', () => {
  it('prefers a test id over everything else', () => {
    const selectors = generator.generate(
      candidate({
        role: 'button',
        accessibleName: 'Login',
        text: 'Login',
        attributes: { 'data-testid': 'login-button', id: 'login', class: 'btn primary' },
      }),
    );

    expect(selectors[0]?.selector).toEqual({ type: 'testId', value: 'login-button' });
    expect(selectors.length).toBeGreaterThan(3);
  });

  it('ranks role+name second, so a renamed test id still resolves', () => {
    const selectors = generator.generate(
      candidate({ role: 'button', accessibleName: 'Login', attributes: { id: 'login-btn' } }),
    );

    expect(selectors[0]?.selector).toEqual({ type: 'role', role: 'button', name: 'Login' });
  });

  it('always produces more than one candidate when signals allow', () => {
    const selectors = generator.generate(
      candidate({
        role: 'button',
        accessibleName: 'Save',
        text: 'Save',
        attributes: { 'data-testid': 'save', id: 'save-btn', name: 'save' },
      }),
    );
    expect(selectors.length).toBeGreaterThanOrEqual(4);
  });

  it('penalizes a dynamic id below a stable alternative', () => {
    const withDynamicId = generator.generate(
      candidate({ role: 'button', accessibleName: 'Save', attributes: { id: 'ember1234' } }),
    );

    const idSelector = withDynamicId.find(
      (entry) => entry.selector.type === 'css' && entry.selector.value.startsWith('#'),
    );
    const roleSelector = withDynamicId.find((entry) => entry.selector.type === 'role');

    expect(idSelector).toBeDefined();
    expect(roleSelector).toBeDefined();
    expect(idSelector!.score).toBeLessThan(roleSelector!.score);
    expect(idSelector!.adjustments.some((a) => a.reason === 'dynamicId')).toBe(true);
  });

  it('excludes hashed class names from a class selector', () => {
    const selectors = generator.generate(
      candidate({ attributes: { class: 'css-1q2w3e4 sc-bdVaJa primary-button' } }),
    );

    const classSelector = selectors.find(
      (entry) => entry.selector.type === 'css' && entry.selector.value.includes('.'),
    );
    expect(classSelector).toBeDefined();
    expect(classSelector!.selector.type === 'css' && classSelector!.selector.value).toContain(
      'primary-button',
    );
    expect(classSelector!.selector.type === 'css' && classSelector!.selector.value).not.toContain(
      'css-1q2w3e4',
    );
  });

  it('produces no class selector when every class is generated', () => {
    const selectors = generator.generate(candidate({ attributes: { class: 'css-1a2b3c sc-XyZaB1' } }));
    const classSelector = selectors.find(
      (entry) => entry.selector.type === 'css' && entry.selector.value.includes('.'),
    );
    expect(classSelector).toBeUndefined();
  });

  it('deduplicates selectors produced by more than one strategy', () => {
    const selectors = generator.generate(
      candidate({ role: 'button', accessibleName: 'Save', text: 'Save' }),
    );
    const descriptions = selectors.map((entry) => JSON.stringify(entry.selector));
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('escapes CSS-special characters in ids', () => {
    const selectors = generator.generate(candidate({ attributes: { id: 'form:email.field' } }));
    const idSelector = selectors.find(
      (entry) => entry.selector.type === 'css' && entry.selector.value.startsWith('#'),
    );

    expect(idSelector).toBeDefined();
    const value = idSelector!.selector.type === 'css' ? idSelector!.selector.value : '';

    // Unescaped, '#form:email.field' parses as an id plus a pseudo-class plus a
    // class, and matches nothing.
    expect(value).toBe(String.raw`#form\:email\.field`);
  });

  it('returns selectors sorted by score', () => {
    const selectors = generator.generate(
      candidate({
        role: 'button',
        accessibleName: 'Login',
        attributes: { 'data-testid': 'login', id: 'x1', class: 'primary-button' },
      }),
    );
    const scores = selectors.map((entry) => entry.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('locator scoring', () => {
  it('heavily penalizes a selector that matches several elements', () => {
    const [best] = generator.generate(candidate({ attributes: { 'data-testid': 'row-action' } }));
    const unique = scorer.score(best!, { matchCount: 1 });
    const ambiguous = scorer.score(best!, { matchCount: 7 });

    expect(ambiguous.score).toBeLessThan(unique.score);
    expect(ambiguous.adjustments.some((a) => a.reason === 'nonUnique')).toBe(true);
  });

  it('rewards a user-confirmed registry element', () => {
    const [best] = generator.generate(candidate({ attributes: { class: 'primary-button' } }));

    const plain = scorer.score(best!, { matchCount: 1 });
    const confirmed = scorer.score(best!, {
      matchCount: 1,
      registryElement: {
        id: 'el_1',
        workspaceRef: 'w',
        systemName: 'x',
        displayName: 'X',
        displayNameSource: 'USER',
        aliases: [],
        primarySelector: { type: 'testId', value: 'x' },
        fallbackSelectors: [],
        userConfirmed: true,
        confidence: 0.9,
        selectorHistory: [],
        namingHistory: [],
        revision: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(confirmed.score).toBeGreaterThan(plain.score);
  });

  it('assigns a stability band alongside the score', () => {
    const [best] = generator.generate(candidate({ attributes: { 'data-testid': 'save' } }));
    expect(scorer.score(best!, { matchCount: 1 }).stability).toBe('HIGH');
  });
});

describe('candidate filtering', () => {
  const page: ElementCandidate[] = [
    candidate({ runtimeId: 'rt_1', accessibleName: 'Login', role: 'button' }),
    candidate({ runtimeId: 'rt_2', accessibleName: 'Sign up', role: 'button' }),
    candidate({ runtimeId: 'rt_3', accessibleName: 'Hidden', role: 'button', visible: false }),
    candidate({
      runtimeId: 'rt_4',
      tag: 'div',
      accessibleName: 'Static text',
      interactable: false,
    }),
    candidate({
      runtimeId: 'rt_5',
      tag: 'input',
      role: 'textbox',
      accessibleName: 'Email',
      editable: true,
    }),
  ];

  it('keeps only interactable, visible candidates', () => {
    const filtered = filterInteractable(page);
    const ids = filtered.map((element) => element.runtimeId);
    expect(ids).toContain('rt_1');
    expect(ids).not.toContain('rt_3');
    expect(ids).not.toContain('rt_4');
  });

  it('keeps read-only elements when interactability is not required', () => {
    // Assertions target headings, badges and error messages — none of which is
    // interactable, and all of which a test needs to be able to name.
    const filtered = filterInteractable(page, { requireInteractable: false });
    const ids = filtered.map((element) => element.runtimeId);
    expect(ids).toContain('rt_4');
    // Still excluded: an invisible element cannot be asserted on either.
    expect(ids).not.toContain('rt_3');
  });

  it('narrows by name', () => {
    const filtered = filterBySemantics(filterInteractable(page), { name: 'Login' });
    expect(filtered.map((element) => element.runtimeId)).toEqual(['rt_1']);
  });

  it('excludes candidates whose role contradicts the intent', () => {
    const filtered = filterBySemantics(filterInteractable(page), {
      name: 'Email',
      role: 'button',
    });
    expect(filtered.map((element) => element.runtimeId)).not.toContain('rt_5');
  });

  it('falls back to the full list rather than returning nothing', () => {
    const filtered = filterBySemantics(filterInteractable(page), {
      name: 'Nothing On This Page',
    });
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('ranks the closest label first', () => {
    const ranked = rankByTextSimilarity(filterInteractable(page), { name: 'Login Button' });
    expect(ranked[0]?.candidate.runtimeId).toBe('rt_1');
  });
});

describe('similarity', () => {
  it('scores an exact match highest', () => {
    expect(similarity('login', 'login')).toBe(1);
  });

  it('scores a containing label above an unrelated one', () => {
    expect(similarity('login', 'login button')).toBeGreaterThan(similarity('login', 'sign up'));
  });

  it('ignores punctuation and case', () => {
    expect(similarity('create customer', 'Create Customer!')).toBeGreaterThan(0.9);
  });

  it('returns zero for empty input', () => {
    expect(similarity('', 'login')).toBe(0);
  });
});

/**
 * The similarity floor in DeterministicElementResolver.
 *
 * `filterBySemantics` deliberately falls back to the whole candidate list when
 * no keyword matches, so a failure reads as "nothing matched my keywords"
 * rather than "nothing on the page". That is right for diagnosis and wrong for
 * resolution: without a floor, an intent naming something absent resolved to
 * whichever candidate ranked first. A real run showed it — an `elementVisible`
 * precondition for "Nonexistent Widget" resolved to `text=Sign in` and reported
 * itself satisfied.
 */
describe('resolving a named intent that matches nothing', () => {
  const loginPage: PageSnapshot = {
    url: 'https://app.test/login',
    capturedAt: '2026-01-01T00:00:00.000Z',
    frames: [],
    pageMetadata: {},
    elements: [
      candidate({ runtimeId: 'rt_1', tag: 'button', role: 'button', accessibleName: 'Sign in' }),
      candidate({
        runtimeId: 'rt_2',
        tag: 'input',
        role: 'textbox',
        accessibleName: 'Email',
        editable: true,
      }),
    ],
  };

  /** Probes always agree, so only the similarity gate can reject a candidate. */
  function browserThatAlwaysMatches(): BrowserPort {
    return {
      sessionId: 'bs_test',
      probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: true }),
    } as unknown as BrowserPort;
  }

  it('refuses to resolve a name nothing on the page resembles', async () => {
    const resolver = new DeterministicElementResolver(noopLogger);

    const resolved = await resolver.resolve({
      intent: { name: 'Nonexistent Widget' },
      snapshot: loginPage,
      browser: browserThatAlwaysMatches(),
      requireInteractable: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('ELEMENT_NOT_FOUND');
  });

  it('reports the closest labels, so the failure is diagnosable', async () => {
    const resolver = new DeterministicElementResolver(noopLogger);

    const resolved = await resolver.resolve({
      intent: { name: 'Nonexistent Widget' },
      snapshot: loginPage,
      browser: browserThatAlwaysMatches(),
      requireInteractable: false,
    });

    if (resolved.ok) return;
    expect(JSON.stringify(resolved.error.details)).toContain('Sign in');
  });

  it('still resolves a name that does match', async () => {
    const resolver = new DeterministicElementResolver(noopLogger);

    const resolved = await resolver.resolve({
      intent: { name: 'Sign in' },
      snapshot: loginPage,
      browser: browserThatAlwaysMatches(),
      requireInteractable: false,
    });

    expect(resolved.ok).toBe(true);
  });

  it('leaves a role-only intent alone, having no name to score', async () => {
    // Judging a role-only intent by label similarity would reject everything.
    const resolver = new DeterministicElementResolver(noopLogger);

    const resolved = await resolver.resolve({
      intent: { role: 'button' },
      snapshot: loginPage,
      browser: browserThatAlwaysMatches(),
      requireInteractable: false,
    });

    expect(resolved.ok).toBe(true);
  });
});

/**
 * The AI boundary: consulted last, and never trusted blindly.
 *
 * Two properties matter more than the ranking itself. The semantic resolver must
 * not be consulted while deterministic resolution is still succeeding — the
 * blueprint is explicit that if AI looks like the fix for ordinary resolution,
 * the bug is in scoring. And whatever it picks is still validated against the
 * live page, so it cannot produce a resolution the page disagrees with.
 */
describe('semantic resolution as a last resort', () => {
  const page: PageSnapshot = {
    url: 'https://app.test/checkout',
    capturedAt: '2026-01-01T00:00:00.000Z',
    frames: [],
    pageMetadata: {},
    elements: [
      candidate({
        runtimeId: 'rt_billing',
        role: 'button',
        accessibleName: 'Submit',
        attributes: { 'data-testid': 'billing-submit' },
        context: { parentText: 'Billing address' },
      }),
      candidate({
        runtimeId: 'rt_shipping',
        role: 'button',
        accessibleName: 'Submit',
        attributes: { 'data-testid': 'shipping-submit' },
        context: { parentText: 'Shipping address' },
      }),
    ],
  };

  function browserThatAgrees(): BrowserPort {
    return {
      sessionId: 'bs_test',
      probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: true }),
    } as unknown as BrowserPort;
  }

  /** A resolver that would pick the shipping button, and records being asked. */
  function semanticSpy(available = true) {
    let calls = 0;
    const port = {
      available,
      rankElements: async () => {
        calls += 1;
        return ok({
          rankings: [
            { runtimeId: 'rt_shipping', score: 0.8, reasoning: 'surrounding text says shipping' },
          ],
          modelRef: 'test-ranker',
        });
      },
    } as unknown as SemanticResolverPort;

    return {
      port,
      get calls() {
        return calls;
      },
    };
  }

  it('is not consulted when labels already resolve the intent', async () => {
    const spy = semanticSpy();
    const resolver = new DeterministicElementResolver(
      noopLogger,
      undefined,
      undefined,
      undefined,
      spy.port,
    );

    const resolved = await resolver.resolve({
      intent: { name: 'Submit' },
      snapshot: page,
      browser: browserThatAgrees(),
      requireInteractable: false,
    });

    expect(resolved.ok).toBe(true);
    expect(spy.calls).toBe(0);
  });

  it('is consulted once labels have refused, and its pick wins', async () => {
    const spy = semanticSpy();
    const resolver = new DeterministicElementResolver(
      noopLogger,
      undefined,
      undefined,
      undefined,
      spy.port,
    );

    // 'Postal code' resembles neither label at all (similarity 0), which is what
    // trips the floor. 'Shipping submit' would score 0.8 and resolve without AI.
    const resolved = await resolver.resolve({
      intent: { name: 'Postal code' },
      snapshot: page,
      browser: browserThatAgrees(),
      requireInteractable: false,
    });

    expect(spy.calls).toBe(1);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.runtimeId).toBe('rt_shipping');
    expect(resolved.value.resolvedVia).toBe('SEMANTIC_AI');
  });

  it('records the model reasoning as evidence a reviewer can read', async () => {
    const spy = semanticSpy();
    const resolver = new DeterministicElementResolver(
      noopLogger,
      undefined,
      undefined,
      undefined,
      spy.port,
    );

    const resolved = await resolver.resolve({
      intent: { name: 'Postal code' },
      snapshot: page,
      browser: browserThatAgrees(),
      requireInteractable: false,
    });

    if (!resolved.ok) return;
    const reasons = resolved.value.evidence.map((item) => item.reason).join(' ');
    expect(reasons).toContain('surrounding text says shipping');
  });

  it('still fails when no resolver is bound', async () => {
    const resolver = new DeterministicElementResolver(noopLogger);

    const resolved = await resolver.resolve({
      intent: { name: 'Postal code' },
      snapshot: page,
      browser: browserThatAgrees(),
      requireInteractable: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('ELEMENT_NOT_FOUND');
  });

  it('ignores a resolver that reports itself unavailable', async () => {
    const spy = semanticSpy(false);
    const resolver = new DeterministicElementResolver(
      noopLogger,
      undefined,
      undefined,
      undefined,
      spy.port,
    );

    const resolved = await resolver.resolve({
      intent: { name: 'Postal code' },
      snapshot: page,
      browser: browserThatAgrees(),
      requireInteractable: false,
    });

    expect(spy.calls).toBe(0);
    expect(resolved.ok).toBe(false);
  });

  it('does not accept a pick the page disagrees with', async () => {
    // The model only ranks; validation is still the arbiter.
    const spy = semanticSpy();
    const resolver = new DeterministicElementResolver(
      noopLogger,
      undefined,
      undefined,
      undefined,
      spy.port,
    );

    const resolved = await resolver.resolve({
      intent: { name: 'Postal code' },
      snapshot: page,
      // Every selector matches three elements: ambiguous, so unusable.
      browser: {
        sessionId: 'bs_test',
        probe: async () => ok({ matchCount: 3, visible: true, enabled: true, editable: true }),
      } as unknown as BrowserPort,
      requireInteractable: false,
    });

    expect(spy.calls).toBe(1);
    expect(resolved.ok).toBe(false);
  });
});
