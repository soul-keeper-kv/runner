import { describe, expect, it, vi } from 'vitest';
import type { BrowserPort, RegistryPort } from '@runner/application';
import type { ElementCandidate } from '@runner/domain';
import type { ElementRegistryItem } from '@runner/registry-model';
import type { LiveSession, PickedElementSnapshot, RawLiveCommand } from '@runner/live-protocol';
import { RunnerErrors, err, noopLogger, ok } from '@runner/shared';
import type { LiveSessionContext } from '../src/capabilities/capability-registry.js';
import { ElementCapability } from '../src/capabilities/element/element-capability.js';

/**
 * What these tests protect: a user who clicks an element gets *that* element,
 * with selectors already checked against the page. The ambiguity of a candidate
 * selector has to be visible at pick time — discovering it later means a run
 * that clicked the wrong row.
 */

function candidate(overrides: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    runtimeId: 'rt_42',
    tag: 'button',
    role: 'button',
    accessibleName: 'Login',
    attributes: { 'data-testid': 'login-submit' },
    visible: true,
    enabled: true,
    editable: false,
    interactable: true,
    bbox: { x: 478, y: 80, width: 49, height: 21 },
    ...overrides,
  };
}

function contextWith(browser: Partial<BrowserPort>): LiveSessionContext {
  return {
    session: {
      id: 'ls_1',
      workspaceRef: 'w1',
      browserSessionId: 'bs_1',
      executionState: 'IDLE',
      revision: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as LiveSession,
    browser: {
      sessionId: 'bs_1',
      describeElementAtPoint: async () => ok(candidate()),
      describeElement: async () => ok(candidate()),
      probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: false }),
      highlight: async () => ok(undefined),
      ...browser,
    } as unknown as BrowserPort,
    logger: noopLogger,
  };
}

function commandOf(type: string, payload: unknown): RawLiveCommand {
  return { id: 'cmd_1', sessionId: 'ls_1', type, payload };
}

describe('element.describe by point', () => {
  it('describes the element at the clicked point with ranked selectors', async () => {
    const result = await new ElementCapability().execute(
      commandOf('element.describe', { point: { x: 500, y: 90 } }),
      contextWith({}),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const picked = result.value as PickedElementSnapshot;
    expect(picked.tag).toBe('button');
    expect(picked.role).toBe('button');
    expect(picked.bbox).toEqual({ x: 478, y: 80, width: 49, height: 21 });
    expect(picked.candidateSelectors.length).toBeGreaterThan(0);
  });

  it('passes the point through to the browser unchanged', async () => {
    const describeElementAtPoint = vi.fn(async () => ok(candidate()));

    await new ElementCapability().execute(
      commandOf('element.describe', { point: { x: 123, y: 456 } }),
      contextWith({ describeElementAtPoint } as unknown as Partial<BrowserPort>),
    );

    // The client sends viewport coordinates; nothing in between reinterprets
    // them, which is what keeps a click aligned with the element.
    expect(describeElementAtPoint).toHaveBeenCalledWith(123, 456);
  });

  it('reports a point with no element rather than inventing one', async () => {
    const result = await new ElementCapability().execute(
      commandOf('element.describe', { point: { x: 9999, y: 9999 } }),
      contextWith({
        describeElementAtPoint: async () =>
          err(RunnerErrors.elementNotFound('point (9999, 9999)')),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ELEMENT_NOT_FOUND');
  });

  it('validates every candidate selector against the live page', async () => {
    // A data-testid that appears three times looks perfect on paper. The user
    // must see that before saving it.
    const result = await new ElementCapability().execute(
      commandOf('element.describe', { point: { x: 500, y: 90 } }),
      contextWith({
        probe: async () => ok({ matchCount: 3, visible: true, enabled: true, editable: false }),
      }),
    );

    if (!result.ok) return;
    const picked = result.value as PickedElementSnapshot;
    expect(picked.candidateSelectors.every((entry) => entry.matchCount === 3)).toBe(true);
  });

  it('ranks a uniquely-matching selector above a stronger ambiguous one', async () => {
    // testId scores 100 but matches many; role+name scores 95 and is unique.
    const result = await new ElementCapability().execute(
      commandOf('element.describe', { point: { x: 500, y: 90 } }),
      contextWith({
        probe: async (scoped: { selector: { type: string } }) =>
          ok({
            matchCount: scoped.selector.type === 'testId' ? 4 : 1,
            visible: true,
            enabled: true,
            editable: false,
          }),
      } as unknown as Partial<BrowserPort>),
    );

    if (!result.ok) return;
    const picked = result.value as PickedElementSnapshot;
    expect(picked.candidateSelectors[0]?.matchCount).toBe(1);
    expect(picked.candidateSelectors[0]?.selector.type).not.toBe('testId');
  });

  it('keeps a selector that could not be evaluated, reporting zero matches', async () => {
    const result = await new ElementCapability().execute(
      commandOf('element.describe', { point: { x: 500, y: 90 } }),
      contextWith({ probe: async () => err(RunnerErrors.selectorInvalid('css', 'bad')) }),
    );

    if (!result.ok) return;
    const picked = result.value as PickedElementSnapshot;
    // Dropped selectors would hide what was considered; zero is the honest answer.
    expect(picked.candidateSelectors.length).toBeGreaterThan(0);
    expect(picked.candidateSelectors.every((entry) => entry.matchCount === 0)).toBe(true);
  });

  it('does not claim a registry match before the Registry is consulted', async () => {
    const result = await new ElementCapability().execute(
      commandOf('element.describe', { point: { x: 500, y: 90 } }),
      contextWith({}),
    );

    if (!result.ok) return;
    expect((result.value as PickedElementSnapshot).matchedElementId).toBeUndefined();
  });
});

describe('element.describe by selector', () => {
  it('describes an element the editor already has a selector for', async () => {
    const describeElement = vi.fn(async () => ok(candidate()));

    const result = await new ElementCapability().execute(
      commandOf('element.describe', { selector: { type: 'testId', value: 'login-submit' } }),
      contextWith({ describeElement } as unknown as Partial<BrowserPort>),
    );

    expect(result.ok).toBe(true);
    expect(describeElement).toHaveBeenCalledWith({
      selector: { type: 'testId', value: 'login-submit' },
    });
  });

  it('rejects a selector that fails the guard, before it reaches the adapter', async () => {
    const describeElement = vi.fn(async () => ok(candidate()));

    const result = await new ElementCapability().execute(
      commandOf('element.describe', {
        selector: { type: 'css', value: 'a[href="javascript:alert(1)"]' },
      }),
      contextWith({ describeElement } as unknown as Partial<BrowserPort>),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SELECTOR_INVALID');
    expect(describeElement).not.toHaveBeenCalled();
  });
});

describe('element.describe with neither point nor selector', () => {
  it('refuses an empty payload', async () => {
    const result = await new ElementCapability().execute(
      commandOf('element.describe', {}),
      contextWith({}),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('explains that a runtimeId alone cannot be resolved', async () => {
    // It identifies an element within one snapshot only; resolving it after the
    // page has moved on would confidently return the wrong element.
    const result = await new ElementCapability().execute(
      commandOf('element.describe', { runtimeId: 'rt_42' }),
      contextWith({}),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(result.error.message).toContain('point');
  });
});

describe('element.highlight', () => {
  it('highlights a validated selector', async () => {
    const highlight = vi.fn(async () => ok(undefined));

    const result = await new ElementCapability().execute(
      commandOf('element.highlight', {
        selector: { type: 'testId', value: 'login-submit' },
        durationMs: 800,
      }),
      contextWith({ highlight } as unknown as Partial<BrowserPort>),
    );

    expect(result.ok).toBe(true);
    expect(highlight).toHaveBeenCalledWith(
      { selector: { type: 'testId', value: 'login-submit' } },
      800,
    );
  });

  it('refuses a hostile selector', async () => {
    const result = await new ElementCapability().execute(
      commandOf('element.highlight', { selector: { type: 'css', value: 'x[y="javascript:x"]' } }),
      contextWith({}),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SELECTOR_INVALID');
  });

  it('says plainly that highlighting by elementId needs the Registry', async () => {
    const result = await new ElementCapability().execute(
      commandOf('element.highlight', { elementId: 'el_1' }),
      contextWith({}),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('pick mode', () => {
  it('acknowledges starting and cancelling', async () => {
    const capability = new ElementCapability();

    const started = await capability.execute(
      commandOf('element.pick.start', {}),
      contextWith({}),
    );
    const cancelled = await capability.execute(
      commandOf('element.pick.cancel', {}),
      contextWith({}),
    );

    expect(started.ok).toBe(true);
    expect((started as { value: { picking: boolean } }).value.picking).toBe(true);
    expect(cancelled.ok).toBe(true);
    expect((cancelled as { value: { picking: boolean } }).value.picking).toBe(false);
  });

  it('claims every element command in the namespace', () => {
    expect(new ElementCapability().handles).toEqual([
      'element.describe',
      'element.highlight',
      'element.pick.start',
      'element.pick.cancel',
    ]);
  });
});

/**
 * Recognizing an element the user already saved.
 *
 * The bug this pins: matching only by name meant "already known" worked exactly
 * when it was least useful. A user names an element for what it *means* ("Sign
 * In Field") while the DOM label says what it *shows* ("Email"), so the two
 * score zero against each other and a freshly saved element looked new on the
 * very next pick. Selector identity is what identifies an element mechanically.
 */
describe('matchedElementId', () => {
  const storedSelector = { type: 'role' as const, role: 'textbox', name: 'Email' };

  function registryHolding(element: Partial<ElementRegistryItem>): RegistryPort {
    const stored = {
      id: 'el_saved',
      workspaceRef: 'w1',
      systemName: 'signInField',
      displayName: 'Sign In Field',
      displayNameSource: 'USER',
      aliases: [],
      primarySelector: storedSelector,
      fallbackSelectors: [],
      userConfirmed: true,
      confidence: 0.9,
      selectorHistory: [],
      namingHistory: [],
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...element,
    } as ElementRegistryItem;

    return {
      findElements: async (lookup) =>
        // A nameless lookup returns the scoped set; a name lookup scores it.
        lookup.name === undefined
          ? ok([{ element: stored, matchScore: 0, matchedOn: 'DISPLAY_NAME' }])
          : ok(
              lookup.name === stored.displayName
                ? [{ element: stored, matchScore: 1, matchedOn: 'DISPLAY_NAME' }]
                : [],
            ),
    } as unknown as RegistryPort;
  }

  it('recognizes a saved element by selector even when the names differ', async () => {
    const capability = new ElementCapability(
      undefined,
      undefined,
      registryHolding({ displayName: 'Sign In Field' }),
    );

    const result = await capability.execute(
      commandOf('element.describe', { point: { x: 1, y: 1 } }),
      contextWith({
        // The picked element's own label is "Email", unlike the saved name.
        describeElementAtPoint: async () =>
          ok(candidate({ accessibleName: 'Email', attributes: {}, role: 'textbox' })),
        probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: true }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as PickedElementSnapshot).matchedElementId).toBe('el_saved');
  });

  it('reports nothing for an element the Registry has never seen', async () => {
    const capability = new ElementCapability(
      undefined,
      undefined,
      registryHolding({ primarySelector: { type: 'testId', value: 'something-else' } }),
    );

    const result = await capability.execute(
      commandOf('element.describe', { point: { x: 1, y: 1 } }),
      contextWith({
        describeElementAtPoint: async () =>
          ok(candidate({ accessibleName: 'Totally Unrelated', attributes: {} })),
        probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: false }),
      }),
    );

    if (!result.ok) return;
    expect((result.value as PickedElementSnapshot).matchedElementId).toBeUndefined();
  });

  it('falls back to the name when no selector matches', async () => {
    // Covers an element whose selector was healed since it was saved.
    const capability = new ElementCapability(
      undefined,
      undefined,
      registryHolding({
        displayName: 'Login',
        primarySelector: { type: 'testId', value: 'moved-since' },
      }),
    );

    const result = await capability.execute(
      commandOf('element.describe', { point: { x: 1, y: 1 } }),
      contextWith({
        describeElementAtPoint: async () => ok(candidate({ accessibleName: 'Login' })),
        probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: false }),
      }),
    );

    if (!result.ok) return;
    expect((result.value as PickedElementSnapshot).matchedElementId).toBe('el_saved');
  });

  it('reports nothing when no registry is wired at all', async () => {
    const capability = new ElementCapability();

    const result = await capability.execute(
      commandOf('element.describe', { point: { x: 1, y: 1 } }),
      contextWith({}),
    );

    if (!result.ok) return;
    expect((result.value as PickedElementSnapshot).matchedElementId).toBeUndefined();
  });
});
