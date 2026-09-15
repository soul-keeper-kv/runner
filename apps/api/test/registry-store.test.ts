import { describe, expect, it } from 'vitest';
import type { ElementRegistryItem } from '@runner/registry-model';
import { fixedClock, noopLogger } from '@runner/shared';
import { InMemoryRegistryStore } from '../src/infrastructure/persistence/in-memory-registry-store.js';

/**
 * These tests exist to protect auditability, which is the Registry's whole
 * reason for being draft-then-commit. They exercise the port, not the storage:
 * the Postgres adapter must satisfy exactly the same assertions.
 */

const WORKSPACE = 'workspace_checkout';

function elementWith(overrides: Partial<ElementRegistryItem> = {}): ElementRegistryItem {
  return {
    id: 'el_login',
    workspaceRef: WORKSPACE,
    systemName: 'loginButton',
    displayName: 'Login Button',
    displayNameSource: 'USER',
    aliases: [],
    primarySelector: { type: 'testId', value: 'login-submit' },
    fallbackSelectors: [],
    userConfirmed: true,
    confidence: 0.97,
    selectorHistory: [],
    namingHistory: [],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function storeWith(elements: readonly ElementRegistryItem[] = []) {
  const clock = fixedClock('2026-01-01T00:00:00.000Z');
  const store = new InMemoryRegistryStore(clock, noopLogger);
  store.seed({ elements });
  return { store, clock };
}

describe('element lookup', () => {
  it('finds an element by its stable id', async () => {
    const { store } = storeWith([elementWith()]);

    const found = await store.findElementById(WORKSPACE, 'el_login');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.displayName).toBe('Login Button');
  });

  it('reports another workspace as not found, never as forbidden', async () => {
    const { store } = storeWith([elementWith()]);

    const found = await store.findElementById('workspace_other', 'el_login');
    expect(found.ok).toBe(false);
    if (found.ok) return;
    // Saying "forbidden" would confirm the id exists somewhere.
    expect(found.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
  });

  it('short-circuits an id lookup instead of also scoring names', async () => {
    const { store } = storeWith([
      elementWith(),
      elementWith({ id: 'el_other', displayName: 'Login Button', systemName: 'loginButton2' }),
    ]);

    const matches = await store.findElements({ workspaceRef: WORKSPACE, elementId: 'el_login' });
    expect(matches.ok).toBe(true);
    if (!matches.ok) return;
    expect(matches.value).toHaveLength(1);
    expect(matches.value[0]?.matchedOn).toBe('ID');
    expect(matches.value[0]?.matchScore).toBe(1);
  });

  it('resolves a name through an alias a user taught it', async () => {
    const { store } = storeWith([
      elementWith({
        aliases: [
          { value: 'Sign in', source: 'USER', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    ]);

    const matches = await store.findElements({ workspaceRef: WORKSPACE, name: 'Sign in' });
    expect(matches.ok).toBe(true);
    if (!matches.ok) return;
    expect(matches.value[0]?.matchedOn).toBe('ALIAS');
  });

  it('ranks a display-name match above an alias match', async () => {
    const { store } = storeWith([
      elementWith({ id: 'el_exact', displayName: 'Submit Order' }),
      elementWith({
        id: 'el_alias',
        displayName: 'Unrelated Control',
        systemName: 'unrelatedControl',
        aliases: [
          { value: 'Submit Order', source: 'AI', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    ]);

    const matches = await store.findElements({ workspaceRef: WORKSPACE, name: 'Submit Order' });
    expect(matches.ok).toBe(true);
    if (!matches.ok) return;
    expect(matches.value[0]?.element.id).toBe('el_exact');
    expect(matches.value[0]?.matchScore).toBeGreaterThan(matches.value[1]!.matchScore);
  });

  it('never returns an element from another workspace', async () => {
    const { store } = storeWith([
      elementWith(),
      elementWith({ id: 'el_leak', workspaceRef: 'workspace_other' }),
    ]);

    const matches = await store.findElements({ workspaceRef: WORKSPACE, name: 'Login Button' });
    expect(matches.ok).toBe(true);
    if (!matches.ok) return;
    expect(matches.value.every((match) => match.element.workspaceRef === WORKSPACE)).toBe(true);
  });

  it('keeps an element whose role is unset when a role hint is given', async () => {
    // A registry entry that predates the hint must not be silently excluded.
    const { store } = storeWith([elementWith({ role: undefined })]);

    const matches = await store.findElements({
      workspaceRef: WORKSPACE,
      name: 'Login Button',
      role: 'button',
    });
    expect(matches.ok).toBe(true);
    if (!matches.ok) return;
    expect(matches.value).toHaveLength(1);
  });

  it('excludes an element whose declared role contradicts the hint', async () => {
    const { store } = storeWith([elementWith({ role: 'link' })]);

    const matches = await store.findElements({
      workspaceRef: WORKSPACE,
      name: 'Login Button',
      role: 'button',
    });
    expect(matches.ok).toBe(true);
    if (!matches.ok) return;
    expect(matches.value).toHaveLength(0);
  });
});

describe('draft-then-commit', () => {
  it('does not change the element until the modification is confirmed', async () => {
    const { store } = storeWith([elementWith()]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'RENAME',
      before: { displayName: 'Login Button' },
      after: { displayName: 'Sign In Button' },
      proposedBy: 'USER',
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.status).toBe('DRAFT');

    const stillOld = await store.findElementById(WORKSPACE, 'el_login');
    expect(stillOld.ok).toBe(true);
    if (!stillOld.ok) return;
    expect(stillOld.value.displayName).toBe('Login Button');

    const confirmed = await store.confirmModification(proposed.value.id, 'reviewer@example.com');
    expect(confirmed.ok).toBe(true);

    const renamed = await store.findElementById(WORKSPACE, 'el_login');
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.displayName).toBe('Sign In Button');
  });

  it('writes a revision whenever it applies a change', async () => {
    const { store } = storeWith([elementWith()]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'SELECTOR_UPDATE',
      before: { primarySelector: { type: 'testId', value: 'login-submit' } },
      after: { primarySelector: { type: 'role', role: 'button', name: 'Login' } },
      proposedBy: 'HEALING',
      executionId: 'run_1',
    });
    if (!proposed.ok) return;

    const confirmed = await store.confirmModification(proposed.value.id, 'auto');
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.version).toBe(1);
    expect(confirmed.value.changedBy).toBe('HEALING');
    expect(confirmed.value.modificationId).toBe(proposed.value.id);

    const history = await store.listRevisions(WORKSPACE, 'el_login');
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value).toHaveLength(1);
  });

  it('numbers revisions monotonically per entity', async () => {
    const { store } = storeWith([elementWith()]);

    for (const name of ['First Rename', 'Second Rename']) {
      const proposed = await store.proposeModification({
        workspaceRef: WORKSPACE,
        entityKind: 'ELEMENT',
        entityId: 'el_login',
        type: 'RENAME',
        before: {},
        after: { displayName: name },
        proposedBy: 'USER',
      });
      if (!proposed.ok) return;
      await store.confirmModification(proposed.value.id, 'reviewer');
    }

    const history = await store.listRevisions(WORKSPACE, 'el_login');
    if (!history.ok) return;
    expect(history.value.map((revision) => revision.version)).toEqual([1, 2]);
  });

  it('increments the element revision on each applied change', async () => {
    const { store } = storeWith([elementWith({ revision: 1 })]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'RENAME',
      before: {},
      after: { displayName: 'Renamed' },
      proposedBy: 'USER',
    });
    if (!proposed.ok) return;
    await store.confirmModification(proposed.value.id, 'reviewer');

    const updated = await store.findElementById(WORKSPACE, 'el_login');
    if (!updated.ok) return;
    expect(updated.value.revision).toBe(2);
  });

  it('refuses to confirm a modification twice, so history is never rewritten', async () => {
    const { store } = storeWith([elementWith()]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'RENAME',
      before: {},
      after: { displayName: 'Once' },
      proposedBy: 'USER',
    });
    if (!proposed.ok) return;

    expect((await store.confirmModification(proposed.value.id, 'reviewer')).ok).toBe(true);

    const again = await store.confirmModification(proposed.value.id, 'reviewer');
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('REGISTRY_CONFLICT');
  });

  it('refuses to reject an already confirmed modification', async () => {
    const { store } = storeWith([elementWith()]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'RENAME',
      before: {},
      after: { displayName: 'Once' },
      proposedBy: 'USER',
    });
    if (!proposed.ok) return;
    await store.confirmModification(proposed.value.id, 'reviewer');

    const rejected = await store.rejectModification(proposed.value.id, 'reviewer', 'too late');
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('REGISTRY_CONFLICT');
  });

  it('leaves the element untouched when a modification is rejected', async () => {
    const { store } = storeWith([elementWith()]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'RENAME',
      before: {},
      after: { displayName: 'Never Applied' },
      proposedBy: 'AI',
    });
    if (!proposed.ok) return;

    const rejected = await store.rejectModification(proposed.value.id, 'reviewer', 'wrong element');
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.status).toBe('REJECTED');
    expect(rejected.value.reason).toBe('wrong element');

    const unchanged = await store.findElementById(WORKSPACE, 'el_login');
    if (!unchanged.ok) return;
    expect(unchanged.value.displayName).toBe('Login Button');
    expect(unchanged.value.revision).toBe(1);

    const history = await store.listRevisions(WORKSPACE, 'el_login');
    if (!history.ok) return;
    expect(history.value).toHaveLength(0);
  });

  it('refuses a modification against an element that does not exist', async () => {
    const { store } = storeWith([]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_missing',
      type: 'RENAME',
      before: {},
      after: { displayName: 'Ghost' },
      proposedBy: 'USER',
    });
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
  });

  it('requires an entityId for anything but a creation', async () => {
    const { store } = storeWith([]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      type: 'RENAME',
      before: {},
      after: { displayName: 'Nameless' },
      proposedBy: 'USER',
    });
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.error.code).toBe('VALIDATION_FAILED');
  });

  it('never lets a modification change an id, which Test IR references', async () => {
    const { store } = storeWith([elementWith()]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'RENAME',
      before: {},
      after: { id: 'el_hijacked', displayName: 'Renamed' },
      proposedBy: 'USER',
    });
    if (!proposed.ok) return;
    await store.confirmModification(proposed.value.id, 'reviewer');

    // The rename applied; the id did not move.
    const original = await store.findElementById(WORKSPACE, 'el_login');
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    expect(original.value.displayName).toBe('Renamed');
    expect((await store.findElementById(WORKSPACE, 'el_hijacked')).ok).toBe(false);
  });

  it('creates an element through a confirmed ELEMENT_CREATE', async () => {
    const { store } = storeWith([]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      type: 'ELEMENT_CREATE',
      before: null,
      after: elementWith({ id: 'el_new', displayName: 'Brand New' }),
      proposedBy: 'RECORDER',
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    // Nothing exists until the draft is confirmed.
    expect((await store.findElementById(WORKSPACE, 'el_new')).ok).toBe(false);

    await store.confirmModification(proposed.value.id, 'reviewer');

    const created = await store.findElementById(WORKSPACE, 'el_new');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.displayName).toBe('Brand New');
    expect(created.value.revision).toBe(1);
  });

  it('deletes an element through a confirmed ELEMENT_DELETE', async () => {
    const { store } = storeWith([elementWith()]);

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'ELEMENT_DELETE',
      before: elementWith(),
      after: null,
      proposedBy: 'USER',
    });
    if (!proposed.ok) return;
    await store.confirmModification(proposed.value.id, 'reviewer');

    expect((await store.findElementById(WORKSPACE, 'el_login')).ok).toBe(false);
  });

  it('lists drafts and proposals as pending, and decided ones not at all', async () => {
    const { store } = storeWith([elementWith()]);

    const draft = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'RENAME',
      before: {},
      after: { displayName: 'A' },
      proposedBy: 'USER',
    });
    const toDecide = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_login',
      type: 'DESCRIPTION_UPDATE',
      before: {},
      after: { description: 'B' },
      proposedBy: 'AI',
      status: 'PROPOSED',
    });
    if (!draft.ok || !toDecide.ok) return;

    const pending = await store.listPendingModifications(WORKSPACE);
    if (!pending.ok) return;
    expect(pending.value).toHaveLength(2);

    await store.confirmModification(toDecide.value.id, 'reviewer');

    const afterDecision = await store.listPendingModifications(WORKSPACE);
    if (!afterDecision.ok) return;
    expect(afterDecision.value.map((modification) => modification.id)).toEqual([draft.value.id]);
  });

  it('refuses to confirm a page modification until Phase 10', async () => {
    const { store } = storeWith([]);
    // Seeded directly: the point is the confirm path, not the proposal check.
    store.seed({
      pages: [
        {
          id: 'pg_login',
          workspaceRef: WORKSPACE,
          displayName: 'Login',
          urlPatterns: ['/login'],
          revision: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'PAGE',
      entityId: 'pg_login',
      type: 'RENAME',
      before: {},
      after: { displayName: 'Sign In' },
      proposedBy: 'USER',
    });
    if (!proposed.ok) return;

    const confirmed = await store.confirmModification(proposed.value.id, 'reviewer');
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.error.code).toBe('CAPABILITY_NOT_IMPLEMENTED');

    // And nothing was recorded for a change that was never applied.
    const history = await store.listRevisions(WORKSPACE, 'pg_login');
    if (!history.ok) return;
    expect(history.value).toHaveLength(0);
  });
});
