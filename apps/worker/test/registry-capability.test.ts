import { describe, expect, it, vi } from 'vitest';
import type { RegistryMatch, RegistryPort } from '@runner/application';
import type { LiveSession, RawLiveCommand } from '@runner/live-protocol';
import type {
  ElementRegistryItem,
  RegistryModification,
  RegistryRevision,
} from '@runner/registry-model';
import { RunnerErrors, err, fixedClock, noopLogger, ok } from '@runner/shared';
import type { LiveSessionContext } from '../src/capabilities/capability-registry.js';
import { RegistryCapability } from '../src/capabilities/registry/registry-capability.js';

/**
 * The invariant these tests protect is ADR 0003: nothing writes the Registry
 * directly. Every command proposes a draft carrying an explicit before/after,
 * and applying it is a separate, recorded decision. A capability that saved
 * straight through would remove undo, diff and reviewable healing permanently.
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
    primarySelector: { type: 'testId', value: 'login-submit' },
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

/** Records what was proposed, so the before/after pair can be inspected. */
function fakeRegistry(options: {
  existing?: ElementRegistryItem;
  modification?: RegistryModification;
} = {}) {
  const proposed: Parameters<RegistryPort['proposeModification']>[0][] = [];
  let confirmedId: string | undefined;
  let rejectedId: string | undefined;

  const registry: RegistryPort = {
    findElementById: async (_workspace, elementId) =>
      options.existing === undefined
        ? err(RunnerErrors.registryEntityNotFound('element', elementId))
        : ok(options.existing),
    findElements: async () => ok([] as RegistryMatch[]),
    listPages: async () => ok([]),
    listComponents: async () => ok([]),
    proposeModification: async (input) => {
      proposed.push(input);
      return ok({
        ...input,
        id: 'mod_1',
        status: input.status ?? 'DRAFT',
        createdAt: '2026-01-01T00:00:00.000Z',
      } as RegistryModification);
    },
    getModification: async (id) =>
      options.modification === undefined
        ? err(RunnerErrors.registryEntityNotFound('modification', id))
        : ok(options.modification),
    listPendingModifications: async () => ok([]),
    confirmModification: async (id) => {
      confirmedId = id;
      return ok({
        id: 'rev_1',
        workspaceRef: WORKSPACE,
        entityKind: 'ELEMENT',
        entityId: 'el_login',
        version: 4,
        changedBy: 'USER',
        changeType: 'RENAME',
        modificationId: id,
        before: {},
        after: {},
        timestamp: '2026-01-01T00:00:00.000Z',
      } as RegistryRevision);
    },
    rejectModification: async (id, _by, reason) => {
      rejectedId = id;
      return ok({
        ...(options.modification as RegistryModification),
        status: 'REJECTED',
        ...(reason === undefined ? {} : { reason }),
      });
    },
    listRevisions: async () => ok([]),
  };

  return {
    registry,
    proposed,
    get confirmedId() {
      return confirmedId;
    },
    get rejectedId() {
      return rejectedId;
    },
  };
}

function contextWith(): LiveSessionContext {
  return {
    session: {
      id: 'ls_1',
      workspaceRef: WORKSPACE,
      browserSessionId: 'bs_1',
      executionState: 'IDLE',
      revision: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as LiveSession,
    browser: { sessionId: 'bs_1' } as never,
    logger: noopLogger,
  };
}

function commandOf(type: string, payload: unknown): RawLiveCommand {
  return { id: 'cmd_1', sessionId: 'ls_1', type, payload };
}

function capabilityWith(registry: RegistryPort) {
  return new RegistryCapability(registry, fixedClock('2026-02-01T00:00:00.000Z'));
}

describe('creating a draft from a pick', () => {
  it('proposes an ELEMENT_CREATE rather than writing the element', async () => {
    const fake = fakeRegistry();

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.create-draft', {
        displayName: 'Create Customer Button',
        selector: { type: 'testId', value: 'create-customer' },
        selectorScore: 100,
      }),
      contextWith(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('DRAFT');
    expect(fake.proposed).toHaveLength(1);
    expect(fake.proposed[0]?.type).toBe('ELEMENT_CREATE');
  });

  it('generates systemName from the display name, never taking it from the caller', async () => {
    // It becomes a code identifier during Page Object generation, so raw user
    // text is not safe there.
    const fake = fakeRegistry();

    await capabilityWith(fake.registry).execute(
      commandOf('registry.create-draft', {
        displayName: 'Create Customer Button',
        selector: { type: 'testId', value: 'create-customer' },
      }),
      contextWith(),
    );

    const created = fake.proposed[0]?.after as ElementRegistryItem;
    expect(created.systemName).toBe('createCustomerButton');
  });

  it('records the name as USER-authored, so an AI suggestion cannot overwrite it', async () => {
    const fake = fakeRegistry();

    await capabilityWith(fake.registry).execute(
      commandOf('registry.create-draft', {
        displayName: 'Login Button',
        selector: { type: 'testId', value: 'x' },
      }),
      contextWith(),
    );

    const created = fake.proposed[0]?.after as ElementRegistryItem;
    expect(created.displayNameSource).toBe('USER');
    expect(created.namingHistory).toHaveLength(1);
  });

  it('does not mark a draft user-confirmed before anyone confirmed it', async () => {
    const fake = fakeRegistry();

    await capabilityWith(fake.registry).execute(
      commandOf('registry.create-draft', {
        displayName: 'Login Button',
        selector: { type: 'testId', value: 'x' },
      }),
      contextWith(),
    );

    const created = fake.proposed[0]?.after as ElementRegistryItem;
    expect(created.userConfirmed).toBe(false);
  });

  it('scopes the element to the session workspace', async () => {
    const fake = fakeRegistry();

    await capabilityWith(fake.registry).execute(
      commandOf('registry.create-draft', {
        displayName: 'Login Button',
        selector: { type: 'testId', value: 'x' },
      }),
      contextWith(),
    );

    expect((fake.proposed[0]?.after as ElementRegistryItem).workspaceRef).toBe(WORKSPACE);
  });

  it('refuses a draft with no display name', async () => {
    const fake = fakeRegistry();

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.create-draft', { selector: { type: 'testId', value: 'x' } }),
      contextWith(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a hostile selector before it is ever stored', async () => {
    const fake = fakeRegistry();

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.create-draft', {
        displayName: 'Sneaky',
        selector: { type: 'css', value: 'a[href="javascript:alert(1)"]' },
      }),
      contextWith(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SELECTOR_INVALID');
    expect(fake.proposed).toHaveLength(0);
  });
});

describe('renaming', () => {
  it('proposes a RENAME carrying the previous name as `before`', async () => {
    const fake = fakeRegistry({ existing: element() });

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.rename', { elementId: 'el_login', displayName: 'Sign In Button' }),
      contextWith(),
    );

    expect(result.ok).toBe(true);
    const proposal = fake.proposed[0];
    expect(proposal?.type).toBe('RENAME');
    // The before/after pair is what makes the change reviewable and undoable.
    expect(proposal?.before).toEqual({ displayName: 'Login Button' });
    expect((proposal?.after as Partial<ElementRegistryItem>).displayName).toBe('Sign In Button');
  });

  it('regenerates systemName, or generated code keeps the old property name', async () => {
    const fake = fakeRegistry({ existing: element() });

    await capabilityWith(fake.registry).execute(
      commandOf('registry.rename', { elementId: 'el_login', displayName: 'Sign In Button' }),
      contextWith(),
    );

    expect((fake.proposed[0]?.after as Partial<ElementRegistryItem>).systemName).toBe(
      'signInButton',
    );
  });

  it('appends to naming history rather than replacing it', async () => {
    const fake = fakeRegistry({
      existing: element({
        namingHistory: [
          { displayName: 'Login Button', source: 'AI', changedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    });

    await capabilityWith(fake.registry).execute(
      commandOf('registry.rename', { elementId: 'el_login', displayName: 'Sign In Button' }),
      contextWith(),
    );

    const history = (fake.proposed[0]?.after as Partial<ElementRegistryItem>).namingHistory ?? [];
    expect(history).toHaveLength(2);
  });

  it('fails when the element does not exist', async () => {
    const fake = fakeRegistry();

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.rename', { elementId: 'el_missing', displayName: 'X' }),
      contextWith(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
  });
});

describe('updating a selector', () => {
  it('keeps the replaced selector as history', async () => {
    // Knowing what a selector used to be is what lets a reviewer judge a heal.
    const fake = fakeRegistry({ existing: element() });

    await capabilityWith(fake.registry).execute(
      commandOf('registry.update-selector', {
        elementId: 'el_login',
        selector: { type: 'role', role: 'button', name: 'Login' },
      }),
      contextWith(),
    );

    const after = fake.proposed[0]?.after as Partial<ElementRegistryItem>;
    expect(after.selectorHistory).toHaveLength(1);
    expect(after.selectorHistory?.[0]?.selector).toEqual({
      type: 'testId',
      value: 'login-submit',
    });
  });

  it('refuses a selector that fails the guard', async () => {
    const fake = fakeRegistry({ existing: element() });

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.update-selector', {
        elementId: 'el_login',
        selector: { type: 'xpath', value: '//a[@href="javascript:x"]' },
      }),
      contextWith(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SELECTOR_INVALID');
  });
});

describe('deciding a modification', () => {
  const pending = {
    id: 'mod_1',
    workspaceRef: WORKSPACE,
    entityKind: 'ELEMENT',
    entityId: 'el_login',
    type: 'RENAME',
    status: 'DRAFT',
    before: {},
    after: {},
    proposedBy: 'USER',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as RegistryModification;

  it('confirms and reports the resulting revision', async () => {
    const fake = fakeRegistry({ modification: pending });

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.confirm', { modificationId: 'mod_1' }),
      contextWith(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('CONFIRMED');
    expect(result.value.revision).toBe(4);
    expect(fake.confirmedId).toBe('mod_1');
  });

  it('rejects with a reason', async () => {
    const fake = fakeRegistry({ modification: pending });

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.reject', { modificationId: 'mod_1', reason: 'wrong element' }),
      contextWith(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('REJECTED');
    expect(fake.rejectedId).toBe('mod_1');
  });

  it('treats a modification from another workspace as absent', async () => {
    // Scoped like every registry read: "not found", never "forbidden".
    const fake = fakeRegistry({
      modification: { ...pending, workspaceRef: 'workspace_other' },
    });

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.confirm', { modificationId: 'mod_1' }),
      contextWith(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REGISTRY_ENTITY_NOT_FOUND');
    expect(fake.confirmedId).toBeUndefined();
  });

  it('requires a modificationId', async () => {
    const fake = fakeRegistry({ modification: pending });

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.confirm', {}),
      contextWith(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('editing a draft in place', () => {
  it('is refused, because it would rewrite a record under review', async () => {
    const fake = fakeRegistry();

    const result = await capabilityWith(fake.registry).execute(
      commandOf('registry.update-draft', { modificationId: 'mod_1', displayName: 'X' }),
      contextWith(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CAPABILITY_NOT_IMPLEMENTED');
  });

  it('claims every registry command in the namespace', () => {
    const fake = fakeRegistry();

    expect(capabilityWith(fake.registry).handles).toEqual([
      'registry.create-draft',
      'registry.update-draft',
      'registry.rename',
      'registry.update-description',
      'registry.update-selector',
      'registry.confirm',
      'registry.reject',
    ]);
  });
});

describe('proposing never confirms', () => {
  it('leaves a created draft for a separate decision', async () => {
    // In REVIEW mode a human decides; in AUTO mode a policy does. Either way the
    // decision is a second, recorded step.
    const fake = fakeRegistry();
    const confirm = vi.spyOn(fake.registry, 'confirmModification');

    await capabilityWith(fake.registry).execute(
      commandOf('registry.create-draft', {
        displayName: 'Login Button',
        selector: { type: 'testId', value: 'x' },
      }),
      contextWith(),
    );

    expect(confirm).not.toHaveBeenCalled();
  });
});
