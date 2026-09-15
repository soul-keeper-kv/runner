import { describe, expect, it } from 'vitest';
import type { BrowserPort } from '@runner/application';
import type { ElementCandidate, PageSnapshot, PageState } from '@runner/domain';
import type { LiveSession, RawLiveCommand } from '@runner/live-protocol';
import { RunnerErrors, err, noopLogger, ok } from '@runner/shared';
import type { LiveSessionContext } from '../src/capabilities/capability-registry.js';
import { StateCapability } from '../src/capabilities/state/state-capability.js';

/**
 * These tests pin the decisions the capability makes, not Playwright's
 * behaviour: which parts of a page are captured by default, and what happens
 * when a piece of the capture fails. Everything is faked through BrowserPort,
 * so no browser launches.
 */

function candidate(overrides: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    runtimeId: 'rt_1',
    tag: 'button',
    role: 'button',
    accessibleName: 'Login',
    attributes: { 'data-testid': 'login-submit' },
    visible: true,
    enabled: true,
    editable: false,
    interactable: true,
    bbox: { x: 10, y: 20, width: 80, height: 30 },
    ...overrides,
  };
}

function contextWith(
  browser: Partial<BrowserPort>,
  session: Partial<LiveSession> = {},
): LiveSessionContext {
  const state: PageState = {
    url: 'https://example.test/login',
    title: 'Sign in',
    frameCount: 1,
    hasOpenDialog: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
  };

  return {
    session: {
      id: 'ls_1',
      workspaceRef: 'w1',
      browserSessionId: 'bs_1',
      executionState: 'IDLE',
      revision: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...session,
    } as LiveSession,
    browser: {
      sessionId: 'bs_1',
      getCurrentState: async () => ok(state),
      screenshot: async () => ok(Buffer.from('fake-png-bytes')),
      inspect: async () =>
        ok({
          url: state.url,
          capturedAt: state.capturedAt,
          elements: [candidate()],
          frames: [],
          pageMetadata: {},
        } as PageSnapshot),
      ...browser,
    } as unknown as BrowserPort,
    logger: noopLogger,
  };
}

function commandOf(type: string, payload: unknown = {}): RawLiveCommand {
  return { id: 'cmd_1', sessionId: 'ls_1', type, payload };
}

describe('state.snapshot', () => {
  it('returns the page state with a frame by default', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.snapshot'),
      contextWith({}),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe('https://example.test/login');
    expect(result.value.title).toBe('Sign in');
    expect(result.value.frame?.format).toBe('png');
    // Base64 of the fake bytes, so the transport carries text, not a Buffer.
    expect(result.value.frame?.data).toBe(Buffer.from('fake-png-bytes').toString('base64'));
  });

  it('omits candidates unless asked, because a full page is large', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.snapshot'),
      contextWith({}),
    );

    if (!result.ok) return;
    expect(result.value.candidates).toBeUndefined();
  });

  it('includes candidates on request', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.snapshot', { includeCandidates: true }),
      contextWith({}),
    );

    if (!result.ok) return;
    expect(result.value.candidateCount).toBe(1);
    expect(result.value.candidates?.[0]).toMatchObject({
      runtimeId: 'rt_1',
      role: 'button',
      label: 'Login',
      bbox: { x: 10, y: 20, width: 80, height: 30 },
    });
  });

  it('does not put internal model detail on the wire', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.snapshot', { includeCandidates: true }),
      contextWith({}),
    );

    if (!result.ok) return;
    const summary = result.value.candidates?.[0] as Record<string, unknown>;
    // Attributes and DOM context are resolution inputs, not view data.
    expect(summary.attributes).toBeUndefined();
    expect(summary.context).toBeUndefined();
  });

  it('can be asked for state alone, with no screenshot', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.snapshot', { includeScreenshot: false }),
      contextWith({}),
    );

    if (!result.ok) return;
    expect(result.value.frame).toBeUndefined();
    expect(result.value.url).toBe('https://example.test/login');
  });

  it('still answers when the screenshot fails', async () => {
    // A page mid-navigation cannot be captured; the URL and state are still
    // worth far more to the workspace than an error.
    const result = await new StateCapability().execute(
      commandOf('state.snapshot'),
      contextWith({ screenshot: async () => err(RunnerErrors.internal('Screenshot failed.')) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frame).toBeUndefined();
    expect(result.value.url).toBe('https://example.test/login');
  });

  it('still answers when candidates cannot be read', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.snapshot', { includeCandidates: true }),
      contextWith({ inspect: async () => err(RunnerErrors.internal('Inspect failed.')) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toBeUndefined();
    expect(result.value.frame).toBeDefined();
  });

  it('fails when the page state itself cannot be read', async () => {
    // Without a URL there is nothing meaningful to report, so this one does
    // fail rather than returning a snapshot of nothing.
    const result = await new StateCapability().execute(
      commandOf('state.snapshot'),
      contextWith({
        getCurrentState: async () => err(RunnerErrors.browserCrashed('context closed')),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BROWSER_CRASHED');
  });

  it('tolerates a malformed payload rather than rejecting the command', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.snapshot', null),
      contextWith({}),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frame).toBeDefined();
  });
});

describe('state.inspect', () => {
  it('returns candidates and skips the frame, inverting the snapshot defaults', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.inspect'),
      contextWith({}),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(1);
    expect(result.value.frame).toBeUndefined();
  });

  it('can still be asked for a frame', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.inspect', { includeScreenshot: true }),
      contextWith({}),
    );

    if (!result.ok) return;
    expect(result.value.frame).toBeDefined();
    expect(result.value.candidates).toHaveLength(1);
  });

  it('caps how many candidates it returns, so a frame stays small', async () => {
    const many = Array.from({ length: 400 }, (_unused, index) =>
      candidate({ runtimeId: `rt_${index}` }),
    );

    const result = await new StateCapability().execute(
      commandOf('state.inspect'),
      contextWith({
        inspect: async () =>
          ok({
            url: 'https://example.test/login',
            capturedAt: '2026-01-01T00:00:00.000Z',
            elements: many,
            frames: [],
            pageMetadata: {},
          } as PageSnapshot),
      }),
    );

    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(150);
    // The true total is still reported, so the UI can say "showing 150 of 400".
    expect(result.value.candidateCount).toBe(400);
  });
});

describe('state.inspect root scoping', () => {
  /*
   * The root reaches the browser rather than being applied afterwards, and that
   * is the whole reason it exists: the candidate cap is then spent inside the
   * container. A capability that filtered the result instead would still lose a
   * panel's elements to a cap consumed by the page around it.
   */
  it('forwards rootSelector to the inspector', async () => {
    let received: unknown;

    await new StateCapability().execute(
      commandOf('state.inspect', { rootSelector: '#panel-1' }),
      contextWith({
        inspect: async (options?: unknown) => {
          received = options;
          return ok({
            url: 'https://example.test/login',
            capturedAt: '2026-01-01T00:00:00.000Z',
            elements: [candidate()],
            frames: [],
            pageMetadata: {},
          } as PageSnapshot);
        },
      }),
    );

    expect(received).toMatchObject({ rootSelector: '#panel-1', interactableOnly: true });
  });

  /*
   * The asymmetry is the point: a transient read failure still answers with a
   * frame, but a root the caller named and got wrong must not come back as a
   * successful snapshot holding no candidates — that is indistinguishable from
   * an empty container, and it is how a scan silently covers the wrong scope.
   */
  it('fails instead of degrading when a named root matches nothing', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.inspect', { rootSelector: '#nope' }),
      contextWith({
        inspect: async () => err(RunnerErrors.elementNotFound('inspection root #nope')),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ELEMENT_NOT_FOUND');
  });

  /*
   * A wildcard root is the normal way to name a panel whose id is generated,
   * and a slightly-too-broad one matches its siblings. Scanning the first would
   * yield a draft for *a* panel with nothing saying which.
   */
  it('fails when a named root matches several elements', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.inspect', { rootSelector: '[id^="caris-tab-"]' }),
      contextWith({
        inspect: async () =>
          err(RunnerErrors.elementAmbiguous('inspection root [id^="caris-tab-"]', 3)),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ELEMENT_AMBIGUOUS');
    expect(result.error.details).toMatchObject({ matchCount: 3 });
  });

  it('still degrades for a read failure when no root was named', async () => {
    const result = await new StateCapability().execute(
      commandOf('state.inspect'),
      contextWith({ inspect: async () => err(RunnerErrors.internal('Inspect failed.')) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toBeUndefined();
    expect(result.value.url).toBe('https://example.test/login');
  });

  it('omits rootSelector entirely when none is given', async () => {
    let received: Record<string, unknown> | undefined;

    await new StateCapability().execute(
      commandOf('state.inspect'),
      contextWith({
        inspect: async (options?: unknown) => {
          received = options as Record<string, unknown>;
          return ok({
            url: 'https://example.test/login',
            capturedAt: '2026-01-01T00:00:00.000Z',
            elements: [candidate()],
            frames: [],
            pageMetadata: {},
          } as PageSnapshot);
        },
      }),
    );

    // Absent rather than undefined: the adapter spreads this straight into
    // page.evaluate, and an explicit undefined would serialize as a key.
    expect(received !== undefined && 'rootSelector' in received).toBe(false);
  });

  it('treats an empty rootSelector as no root', async () => {
    let received: Record<string, unknown> | undefined;

    await new StateCapability().execute(
      commandOf('state.inspect', { rootSelector: '' }),
      contextWith({
        inspect: async (options?: unknown) => {
          received = options as Record<string, unknown>;
          return ok({
            url: 'https://example.test/login',
            capturedAt: '2026-01-01T00:00:00.000Z',
            elements: [candidate()],
            frames: [],
            pageMetadata: {},
          } as PageSnapshot);
        },
      }),
    );

    expect(received !== undefined && 'rootSelector' in received).toBe(false);
  });
});
