import { describe, expect, it } from 'vitest';
import type { ElementCandidate } from '@runner/domain';
import type { ElementRegistryItem } from '@runner/registry-model';
import { fixedClock, noopLogger } from '@runner/shared';
import { HeuristicSemanticResolver } from '../src/infrastructure/semantic/heuristic-semantic-resolver.js';

/**
 * What this resolver is for: ranking on signals the deterministic pass throws
 * away — the text around an element, the form and component it sits in, the
 * landmark above it. These tests pin that those signals actually decide, and
 * that the boundary's constraints hold: it only ranks, it explains itself, and
 * it refuses rather than guessing when nothing is convincing.
 */

function candidate(overrides: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    runtimeId: 'rt_1',
    tag: 'button',
    role: 'button',
    accessibleName: 'Submit',
    attributes: {},
    visible: true,
    enabled: true,
    editable: false,
    interactable: true,
    ...overrides,
  };
}

function registryElement(overrides: Partial<ElementRegistryItem> = {}): ElementRegistryItem {
  return {
    id: 'el_1',
    workspaceRef: 'w1',
    systemName: 'shippingSubmit',
    displayName: 'Shipping Submit',
    displayNameSource: 'USER',
    aliases: [],
    primarySelector: { type: 'testId', value: 'x' },
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

function resolver(options?: { minScore?: number; maxCandidates?: number }) {
  return new HeuristicSemanticResolver(
    noopLogger,
    fixedClock('2026-01-01T00:00:00.000Z'),
    options,
  );
}

describe('ranking on context rather than labels', () => {
  it('prefers the candidate whose surrounding text matches the intent', async () => {
    // Two identical "Submit" buttons; only the context distinguishes them.
    const result = await resolver().rankElements({
      intent: { name: 'Shipping submit' },
      candidates: [
        candidate({ runtimeId: 'rt_billing', context: { parentText: 'Billing address' } }),
        candidate({ runtimeId: 'rt_shipping', context: { parentText: 'Shipping address' } }),
      ],
      registryCandidates: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rankings[0]?.runtimeId).toBe('rt_shipping');
  });

  it('uses a component or form name as a signal', async () => {
    const result = await resolver().rankElements({
      intent: { name: 'Checkout submit' },
      candidates: [
        candidate({ runtimeId: 'rt_other', context: { formHint: 'newsletter' } }),
        candidate({ runtimeId: 'rt_checkout', context: { formHint: 'checkout' } }),
      ],
      registryCandidates: [],
    });

    if (!result.ok) return;
    expect(result.value.rankings[0]?.runtimeId).toBe('rt_checkout');
  });

  it('uses a landmark the intent names', async () => {
    const result = await resolver().rankElements({
      intent: { name: 'dialog save' },
      candidates: [
        candidate({ runtimeId: 'rt_page', accessibleName: 'Save', context: { landmark: 'main' } }),
        candidate({
          runtimeId: 'rt_dialog',
          accessibleName: 'Save',
          context: { landmark: 'dialog' },
        }),
      ],
      registryCandidates: [],
    });

    if (!result.ok) return;
    expect(result.value.rankings[0]?.runtimeId).toBe('rt_dialog');
  });

  it('weights a confirmed registry mapping above an unconfirmed one', async () => {
    // A person looking at the real page is better evidence than any heuristic.
    const confirmed = await resolver().rankElements({
      intent: { name: 'Shipping Submit' },
      candidates: [candidate()],
      registryCandidates: [registryElement({ userConfirmed: true })],
    });
    const unconfirmed = await resolver().rankElements({
      intent: { name: 'Shipping Submit' },
      candidates: [candidate()],
      registryCandidates: [registryElement({ userConfirmed: false })],
    });

    if (!confirmed.ok || !unconfirmed.ok) return;
    expect(confirmed.value.rankings[0]!.score).toBeGreaterThan(
      unconfirmed.value.rankings[0]!.score,
    );
  });

  it('reports the registry element it matched, so the caller can link it', async () => {
    const result = await resolver().rankElements({
      intent: { name: 'Shipping Submit' },
      candidates: [candidate()],
      registryCandidates: [registryElement({ userConfirmed: true })],
    });

    if (!result.ok) return;
    expect(result.value.rankings[0]?.elementId).toBe('el_1');
  });
});

describe('explaining itself', () => {
  it('gives a reason built from the same facts as the score', async () => {
    // A resolution a reviewer cannot audit is worse than a failure they can.
    const result = await resolver().rankElements({
      intent: { name: 'Shipping submit', role: 'button' },
      candidates: [candidate({ context: { parentText: 'Shipping address' } })],
      registryCandidates: [],
    });

    if (!result.ok) return;
    const reasoning = result.value.rankings[0]?.reasoning ?? '';
    expect(reasoning).toContain('surrounding text');
    expect(reasoning).toContain('role matches button');
  });

  it('names which ranker produced the result', async () => {
    const result = await resolver().rankElements({
      intent: { name: 'Shipping submit' },
      candidates: [candidate({ context: { parentText: 'Shipping address' } })],
      registryCandidates: [],
    });

    if (!result.ok) return;
    // An LLM adapter reports its model here instead; either way the timeline can
    // say what chose the element.
    expect(result.value.modelRef).toBe('heuristic-context-v1');
    expect(result.value.latencyMs).toBeTypeOf('number');
  });
});

describe('refusing rather than guessing', () => {
  it('returns no rankings when nothing is convincing', async () => {
    const result = await resolver().rankElements({
      intent: { name: 'Shipping submit' },
      candidates: [candidate({ accessibleName: 'Postal code', context: { parentText: 'Zip' } })],
      registryCandidates: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rankings).toHaveLength(0);
  });

  it('returns nothing for an intent with no text to reason about', async () => {
    // A role-only intent gives a semantic ranker nothing to work with, and
    // inventing a score for it would be pure noise.
    const result = await resolver().rankElements({
      intent: { role: 'button' },
      candidates: [candidate()],
      registryCandidates: [],
    });

    if (!result.ok) return;
    expect(result.value.rankings).toHaveLength(0);
  });

  it('honours a caller-supplied floor', async () => {
    const strict = await resolver({ minScore: 0.99 }).rankElements({
      intent: { name: 'Shipping submit' },
      candidates: [candidate({ context: { parentText: 'Shipping address' } })],
      registryCandidates: [],
    });

    if (!strict.ok) return;
    expect(strict.value.rankings).toHaveLength(0);
  });

  it('caps the shortlist rather than scoring a whole page', async () => {
    // If this ever needs raising, deterministic filtering is not doing its job.
    const many = Array.from({ length: 50 }, (_unused, index) =>
      candidate({ runtimeId: `rt_${index}`, context: { parentText: 'Shipping address' } }),
    );

    const result = await resolver({ maxCandidates: 5 }).rankElements({
      intent: { name: 'Shipping submit' },
      candidates: many,
      registryCandidates: [],
    });

    if (!result.ok) return;
    expect(result.value.rankings.length).toBeLessThanOrEqual(5);
  });

  it('reports itself available, unlike the default binding', async () => {
    expect(resolver().available).toBe(true);
  });

  it('never returns a score above 1', async () => {
    const result = await resolver().rankElements({
      intent: { name: 'Shipping Submit', role: 'button' },
      candidates: [
        candidate({
          accessibleName: 'Shipping Submit',
          context: {
            parentText: 'Shipping Submit',
            componentHint: 'shipping submit',
            formHint: 'shipping submit',
            landmark: 'shipping',
          },
        }),
      ],
      registryCandidates: [registryElement({ userConfirmed: true })],
    });

    if (!result.ok) return;
    expect(result.value.rankings[0]!.score).toBeLessThanOrEqual(1);
  });
});
