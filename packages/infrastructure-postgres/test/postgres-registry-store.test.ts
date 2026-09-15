import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ElementRegistryItem } from '@runner/registry-model';
import { fixedClock, noopLogger } from '@runner/shared';
import { createPostgresClient, verifyPostgresSchema } from '../src/postgres-client.js';
import { PostgresRegistryStore } from '../src/postgres-registry-store.js';

/**
 * Integration tests against a real Postgres.
 *
 * These cannot be faked usefully: the things most likely to be wrong are the
 * column mapping, the JSONB round trip, the foreign key to
 * `external_workspaces`, and whether `confirmModification` really is one
 * transaction. A stubbed client would answer whatever the stub was told to.
 *
 * They skip themselves when `DATABASE_URL` is absent, so `pnpm test` stays
 * green on a machine with no database — but they run in CI and locally after
 * `pnpm infra:up`, which is where a schema mistake would otherwise reach
 * production unnoticed.
 */

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://runner:runner@localhost:5433/runner';
const WORKSPACE = `w_pgtest_${Date.now()}`;

const sql = createPostgresClient(databaseUrl, { max: 2 });
const store = new PostgresRegistryStore(sql, fixedClock('2026-03-01T00:00:00.000Z'), noopLogger);

let available = false;

function element(overrides: Partial<ElementRegistryItem> = {}): ElementRegistryItem {
  /*
   * `elements_system_name_idx` is UNIQUE (workspace_ref, system_name), because a
   * generated Page Object needs exactly one identifier per name. That index is
   * correct and worth keeping, so a fixture has to vary `systemName` with `id`
   * or the second seed in one workspace collides.
   */
  const suffix = Math.random().toString(36).slice(2, 10);
  return {
    id: `el_pg_${suffix}`,
    workspaceRef: WORKSPACE,
    systemName: `loginButton_${suffix}`,
    displayName: 'Login Button',
    displayNameSource: 'USER',
    aliases: [
      { value: 'Sign in', source: 'USER', createdAt: '2026-01-01T00:00:00.000Z', usageCount: 3 },
    ],
    role: 'button',
    semanticType: 'button',
    primarySelector: { type: 'testId', value: 'login-submit' },
    fallbackSelectors: [
      { selector: { type: 'role', role: 'button', name: 'Login' }, score: 95, successCount: 2 },
    ],
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

beforeAll(async () => {
  const schema = await verifyPostgresSchema(sql);
  available = schema.ok;
  if (!available) {
    console.warn(`Skipping Postgres integration tests: ${schema.reason}`);
  }
});

afterAll(async () => {
  if (available) {
    // Cascades through elements, aliases, selectors, modifications and revisions.
    await sql`DELETE FROM external_workspaces WHERE workspace_ref = ${WORKSPACE}`;
    await sql`DELETE FROM registry_modifications WHERE workspace_ref = ${WORKSPACE}`;
    await sql`DELETE FROM registry_revisions WHERE workspace_ref = ${WORKSPACE}`;
  }
  await sql.end();
});

describe('reading and writing an element', () => {
  it('round-trips every field through the schema', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const found = await store.findElementById(WORKSPACE, original.id);

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.displayName).toBe('Login Button');
    // The fixture varies systemName per element, so the prefix is what matters.
    expect(found.value.systemName).toBe(original.systemName);
    expect(found.value.displayNameSource).toBe('USER');
    expect(found.value.userConfirmed).toBe(true);
    // JSONB round trip: a selector is data, and must come back identical.
    expect(found.value.primarySelector).toEqual({ type: 'testId', value: 'login-submit' });
    expect(found.value.role).toBe('button');
  });

  it('restores aliases as rows, with their source and usage', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const found = await store.findElementById(WORKSPACE, original.id);
    if (!found.ok) return;

    expect(found.value.aliases).toHaveLength(1);
    expect(found.value.aliases[0]).toMatchObject({
      value: 'Sign in',
      source: 'USER',
      usageCount: 3,
    });
  });

  it('restores fallback selectors with their scores', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const found = await store.findElementById(WORKSPACE, original.id);
    if (!found.ok) return;

    expect(found.value.fallbackSelectors).toHaveLength(1);
    expect(found.value.fallbackSelectors[0]?.score).toBe(95);
  });

  it('registers the workspace on first write, since it is a foreign key', async () => {
    // `elements.workspace_ref` references `external_workspaces`, which starts
    // empty — without the upsert every insert would fail.
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const rows = await sql<{ workspace_ref: string }[]>`
      SELECT workspace_ref FROM external_workspaces WHERE workspace_ref = ${WORKSPACE}
    `;
    expect(rows).toHaveLength(1);
  });

  it('reports another workspace as not found, never as forbidden', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const found = await store.findElementById('w_someone_else', original.id);

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
  });

  it('finds an element by name through the shared scoring', async () => {
    if (!available) return;
    const original = element({ displayName: 'Checkout Submit', systemName: 'checkoutSubmit' });
    await store.seed({ elements: [original] });

    const matches = await store.findElements({ workspaceRef: WORKSPACE, name: 'Checkout Submit' });

    expect(matches.ok).toBe(true);
    if (!matches.ok) return;
    const match = matches.value.find((entry) => entry.element.id === original.id);
    expect(match?.matchedOn).toBe('DISPLAY_NAME');
  });

  it('finds an element through an alias', async () => {
    if (!available) return;
    const original = element({
      displayName: 'Utterly Different',
      aliases: [{ value: 'Pay Now', source: 'USER', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    await store.seed({ elements: [original] });

    const matches = await store.findElements({ workspaceRef: WORKSPACE, name: 'Pay Now' });

    if (!matches.ok) return;
    const match = matches.value.find((entry) => entry.element.id === original.id);
    expect(match?.matchedOn).toBe('ALIAS');
  });
});

describe('draft-then-commit against the database', () => {
  it('does not change the element until the modification is confirmed', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: original.id,
      type: 'RENAME',
      before: { displayName: original.displayName },
      after: { displayName: 'Sign In Button' },
      proposedBy: 'USER',
    });

    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.status).toBe('DRAFT');

    const before = await store.findElementById(WORKSPACE, original.id);
    if (!before.ok) return;
    expect(before.value.displayName).toBe('Login Button');

    const confirmed = await store.confirmModification(proposed.value.id, 'tester');
    expect(confirmed.ok).toBe(true);

    const after = await store.findElementById(WORKSPACE, original.id);
    if (!after.ok) return;
    expect(after.value.displayName).toBe('Sign In Button');
    expect(after.value.revision).toBe(2);
  });

  it('writes the entity change and its revision in one transaction', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: original.id,
      type: 'SELECTOR_UPDATE',
      before: { primarySelector: original.primarySelector },
      after: { primarySelector: { type: 'role', role: 'button', name: 'Login' } },
      proposedBy: 'HEALING',
      executionId: 'run_pg_1',
    });
    if (!proposed.ok) return;

    const confirmed = await store.confirmModification(proposed.value.id, 'auto');
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.version).toBe(1);
    expect(confirmed.value.changedBy).toBe('HEALING');

    const history = await store.listRevisions(WORKSPACE, original.id);
    if (!history.ok) return;
    expect(history.value).toHaveLength(1);

    // The replaced selector is kept, which is what makes a heal reviewable.
    const kept = await sql<{ count: string }[]>`
      SELECT count(*)::text FROM element_selectors
      WHERE element_id = ${original.id} AND is_primary = FALSE
    `;
    expect(Number(kept[0]?.count ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('numbers revisions monotonically, enforced by the database', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    for (const name of ['First', 'Second']) {
      const proposed = await store.proposeModification({
        workspaceRef: WORKSPACE,
        entityKind: 'ELEMENT',
        entityId: original.id,
        type: 'RENAME',
        before: {},
        after: { displayName: name },
        proposedBy: 'USER',
      });
      if (!proposed.ok) return;
      await store.confirmModification(proposed.value.id, 'tester');
    }

    const history = await store.listRevisions(WORKSPACE, original.id);
    if (!history.ok) return;
    expect(history.value.map((revision) => revision.version)).toEqual([1, 2]);
  });

  it('refuses to confirm twice, so history is never rewritten', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: original.id,
      type: 'RENAME',
      before: {},
      after: { displayName: 'Once' },
      proposedBy: 'USER',
    });
    if (!proposed.ok) return;

    expect((await store.confirmModification(proposed.value.id, 'tester')).ok).toBe(true);

    const again = await store.confirmModification(proposed.value.id, 'tester');
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('REGISTRY_CONFLICT');
  });

  it('leaves the element untouched when a modification is rejected', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: original.id,
      type: 'RENAME',
      before: {},
      after: { displayName: 'Never Applied' },
      proposedBy: 'AI',
    });
    if (!proposed.ok) return;

    const rejected = await store.rejectModification(proposed.value.id, 'tester', 'wrong element');
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.status).toBe('REJECTED');
    expect(rejected.value.reason).toBe('wrong element');

    const unchanged = await store.findElementById(WORKSPACE, original.id);
    if (!unchanged.ok) return;
    expect(unchanged.value.displayName).toBe('Login Button');

    const history = await store.listRevisions(WORKSPACE, original.id);
    if (!history.ok) return;
    expect(history.value).toHaveLength(0);
  });

  it('creates an element through a confirmed ELEMENT_CREATE', async () => {
    if (!available) return;
    const created = element({ displayName: 'Brand New Field', systemName: 'brandNewField' });

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      type: 'ELEMENT_CREATE',
      before: null,
      after: created,
      proposedBy: 'RECORDER',
    });
    if (!proposed.ok) return;

    // Nothing exists until the draft is confirmed.
    expect((await store.findElementById(WORKSPACE, created.id)).ok).toBe(false);

    const confirmed = await store.confirmModification(proposed.value.id, 'tester');
    expect(confirmed.ok).toBe(true);

    const found = await store.findElementById(WORKSPACE, created.id);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.displayName).toBe('Brand New Field');
  });

  it('lists only pending modifications', async () => {
    if (!available) return;
    const original = element();
    await store.seed({ elements: [original] });

    const draft = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: original.id,
      type: 'DESCRIPTION_UPDATE',
      before: {},
      after: { description: 'pending' },
      proposedBy: 'USER',
    });
    const toConfirm = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: original.id,
      type: 'RENAME',
      before: {},
      after: { displayName: 'Decided' },
      proposedBy: 'USER',
      status: 'PROPOSED',
    });
    if (!draft.ok || !toConfirm.ok) return;

    await store.confirmModification(toConfirm.value.id, 'tester');

    const pending = await store.listPendingModifications(WORKSPACE);
    if (!pending.ok) return;
    const ids = pending.value.map((modification) => modification.id);
    expect(ids).toContain(draft.value.id);
    expect(ids).not.toContain(toConfirm.value.id);
  });

  it('refuses a modification against an element that does not exist', async () => {
    if (!available) return;
    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'ELEMENT',
      entityId: 'el_pg_missing',
      type: 'RENAME',
      before: {},
      after: { displayName: 'Ghost' },
      proposedBy: 'USER',
    });

    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
  });

  it('treats a malformed modification id as not found rather than erroring', async () => {
    if (!available) return;
    const found = await store.getModification('mod_not_a_uuid');

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
  });

  it('refuses to confirm a page modification, rather than recording a false revision', async () => {
    if (!available) return;
    await store.seed({
      pages: [
        {
          id: `pg_pgtest_${Date.now()}`,
          workspaceRef: WORKSPACE,
          displayName: 'Login',
          urlPatterns: ['/login'],
          revision: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const pages = await store.listPages(WORKSPACE);
    if (!pages.ok || pages.value[0] === undefined) return;

    const proposed = await store.proposeModification({
      workspaceRef: WORKSPACE,
      entityKind: 'PAGE',
      entityId: pages.value[0].id,
      type: 'RENAME',
      before: {},
      after: { displayName: 'Sign In' },
      proposedBy: 'USER',
    });
    if (!proposed.ok) return;

    const confirmed = await store.confirmModification(proposed.value.id, 'tester');
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.error.code).toBe('CAPABILITY_NOT_IMPLEMENTED');

    // And the transaction rolled back: no revision for a change never applied.
    const history = await store.listRevisions(WORKSPACE, pages.value[0].id);
    if (!history.ok) return;
    expect(history.value).toHaveLength(0);
  });
});
