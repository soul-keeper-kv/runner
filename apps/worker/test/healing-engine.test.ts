import { describe, expect, it, vi } from 'vitest';
import type { BrowserPort, RegistryPort } from '@runner/application';
import type { ElementCandidate, PageSnapshot } from '@runner/domain';
import type { ElementRegistryItem, RegistryModification } from '@runner/registry-model';
import { fixedClock, noopLogger, ok } from '@runner/shared';
import { HealingEngine, confidenceOf } from '../src/modules/healing/healing-engine.js';

/**
 * The invariant these tests exist to protect: healing **proposes**, never
 * mutates. A silently rewritten selector makes the Registry untrustworthy at
 * exactly the moment a person most needs to know what changed.
 *
 * The rest of them pin what a *good* proposal is: found by meaning rather than
 * by position, unique rather than merely plausible, and never offered at all
 * when the stored selector still works.
 */

const WORKSPACE = 'workspace_demo';

function element(overrides: Partial<ElementRegistryItem> = {}): ElementRegistryItem {
  return {
    id: 'el_login',
    workspaceRef: WORKSPACE,
    systemName: 'loginButton',
    displayName: 'Login Button',
    displayNameSource: 'USER',
    aliases: [],
    role: 'button',
    primarySelector: { type: 'testId', value: 'old-login-id' },
    fallbackSelectors: [],
    userConfirmed: true,
    confidence: 0.97,
    selectorHistory: [],
    namingHistory: [],
    revision: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function candidate(overrides: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    runtimeId: 'rt_1',
    tag: 'button',
    role: 'button',
    accessibleName: 'Login Button',
    attributes: { 'data-testid': 'new-login-id' },
    visible: true,
    enabled: true,
    editable: false,
    interactable: true,
    ...overrides,
  };
}

function snapshotOf(elements: ElementCandidate[]): PageSnapshot {
  return {
    url: 'https://app.test/login',
    capturedAt: '2026-01-01T00:00:00.000Z',
    elements,
    frames: [],
    pageMetadata: {},
  };
}

/**
 * A browser whose probes answer per selector type, so a test can make the old
 * selector fail and a new one succeed.
 */
function browserWhere(
  matchCounts: Record<string, number>,
  fallback = 1,
): BrowserPort {
  return {
    sessionId: 'bs_1',
    probe: async (scoped: { selector: { type: string; value?: string } }) => {
      const key = scoped.selector.value ?? scoped.selector.type;
      const matchCount = matchCounts[key] ?? fallback;
      return ok({ matchCount, visible: matchCount > 0, enabled: true, editable: false });
    },
  } as unknown as BrowserPort;
}

function fakeRegistry() {
  const proposed: Parameters<RegistryPort['proposeModification']>[0][] = [];
  const confirm = vi.fn();

  const registry = {
    proposeModification: async (input) => {
      proposed.push(input);
      return ok({
        ...input,
        id: 'mod_heal_1',
        status: input.status ?? 'DRAFT',
        createdAt: '2026-02-01T00:00:00.000Z',
      } as RegistryModification);
    },
    confirmModification: confirm,
  } as unknown as RegistryPort;

  return { registry, proposed, confirm };
}

function engineWith(registry: RegistryPort) {
  return new HealingEngine({
    registry,
    clock: fixedClock('2026-02-01T00:00:00.000Z'),
    logger: noopLogger,
  });
}

describe('healing proposes rather than mutates', () => {
  it('records a SELECTOR_UPDATE proposal and never confirms it', async () => {
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      // The old testId matches nothing; the new one is unique.
      browser: browserWhere({ 'old-login-id': 0, 'new-login-id': 1 }),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fake.proposed).toHaveLength(1);
    expect(fake.proposed[0]?.type).toBe('SELECTOR_UPDATE');
    expect(fake.proposed[0]?.proposedBy).toBe('HEALING');
    // The decision to apply belongs to the caller, and must be recorded.
    expect(fake.confirm).not.toHaveBeenCalled();
  });

  it('carries the replaced selector as `before`, so the change is reviewable', async () => {
    const fake = fakeRegistry();

    await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 0, 'new-login-id': 1 }),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    expect(fake.proposed[0]?.before).toEqual({
      primarySelector: { type: 'testId', value: 'old-login-id' },
    });
  });

  it('keeps the replaced selector in history, attributed to HEALING', async () => {
    // Knowing what a selector used to be is what lets a reviewer judge the heal.
    const fake = fakeRegistry();

    await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 0, 'new-login-id': 1 }),
      executionId: 'run_42',
      mode: 'AUTO',
    });

    const after = fake.proposed[0]?.after as Partial<ElementRegistryItem>;
    expect(after.selectorHistory).toHaveLength(1);
    expect(after.selectorHistory?.[0]?.replacedBy).toBe('HEALING');
    expect(after.selectorHistory?.[0]?.reason).toContain('run_42');
  });

  it('proposes as PROPOSED, not DRAFT — it is a finished suggestion', async () => {
    const fake = fakeRegistry();

    await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 0, 'new-login-id': 1 }),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    expect(fake.proposed[0]?.status).toBe('PROPOSED');
  });

  it('links the proposal to the execution that triggered it', async () => {
    const fake = fakeRegistry();

    await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 0, 'new-login-id': 1 }),
      executionId: 'run_99',
      mode: 'AUTO',
    });

    expect(fake.proposed[0]?.executionId).toBe('run_99');
  });
});

describe('refusing to heal', () => {
  it('refuses when the stored selector still matches', async () => {
    // The failure was something else — a precondition, a timing issue, a real
    // bug — and replacing the selector would hide it.
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 1 }),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('nothing to heal');
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses when the element is genuinely absent from the page', async () => {
    // A broken selector and an element that is not there yet need different
    // fixes; healing must not paper over the second.
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([]),
      browser: browserWhere({ 'old-login-id': 0 }),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ELEMENT_NOT_FOUND');
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses a replacement that resolves ambiguously', async () => {
    // Healing onto a selector matching three elements trades a failing test for
    // a wrong one.
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 0 }, 3),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ELEMENT_NOT_FOUND');
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses a candidate whose label resembles nothing it was looking for', async () => {
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element({ displayName: 'Login Button' }),
      snapshot: snapshotOf([
        candidate({ accessibleName: 'Postal Code', attributes: { id: 'zip' } }),
      ]),
      browser: browserWhere({ 'old-login-id': 0 }),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    expect(result.ok).toBe(false);
    expect(fake.proposed).toHaveLength(0);
  });
});

describe('finding the element by meaning', () => {
  it('matches through an alias when the visible label changed', async () => {
    // A UI change often renames the label while an alias still describes it.
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element({
        displayName: 'Nothing Like It',
        aliases: [
          { value: 'Sign In Button', source: 'USER', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
      snapshot: snapshotOf([
        candidate({ accessibleName: 'Sign In Button', attributes: { 'data-testid': 'new-id' } }),
      ]),
      browser: browserWhere({ 'old-login-id': 0, 'new-id': 1 }),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replacement).toEqual({ type: 'testId', value: 'new-id' });
  });

  it('reports evidence a reviewer can read', async () => {
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 0, 'new-login-id': 1 }),
      executionId: 'run_1',
      mode: 'AUTO',
    });

    if (!result.ok) return;
    expect(result.value.evidence.join(' ')).toContain('no longer matches');
    expect(result.value.evidence.join(' ')).toContain('re-located');
  });
});

describe('auto-commit policy', () => {
  it('does not mark a proposal auto-committable in REVIEW mode', async () => {
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 0, 'new-login-id': 1 }),
      executionId: 'run_1',
      mode: 'REVIEW',
    });

    if (!result.ok) return;
    expect(result.value.autoCommittable).toBe(false);
  });

  it('never marks a proposal auto-committable in INTERACTIVE mode', async () => {
    const fake = fakeRegistry();

    const result = await engineWith(fake.registry).proposeReplacement({
      element: element(),
      snapshot: snapshotOf([candidate()]),
      browser: browserWhere({ 'old-login-id': 0, 'new-login-id': 1 }),
      executionId: 'run_1',
      mode: 'INTERACTIVE',
    });

    if (!result.ok) return;
    expect(result.value.autoCommittable).toBe(false);
  });
});

describe('confidence in a replacement', () => {
  it('rewards a strong selector and a close name match', () => {
    expect(confidenceOf(100, 1, false)).toBeGreaterThan(confidenceOf(60, 0.5, false));
  });

  it('gives a confirmed element only a small nudge, never a free pass', () => {
    // The confirmation belongs to the selector being *replaced*, not the new one,
    // so it must not on its own clear the 0.97 auto-heal threshold.
    const weak = confidenceOf(30, 0.4, true);
    expect(weak).toBeLessThan(0.97);
    expect(weak).toBeGreaterThan(confidenceOf(30, 0.4, false));
  });

  it('stays within 0..1', () => {
    expect(confidenceOf(100, 1, true)).toBeLessThanOrEqual(1);
    expect(confidenceOf(0, 0, false)).toBeGreaterThanOrEqual(0);
  });
});
