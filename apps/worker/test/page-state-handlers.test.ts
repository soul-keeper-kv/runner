import { describe, expect, it, vi } from 'vitest';
import type { BrowserManagerPort, BrowserPort } from '@runner/application';
import type { ExecutionContext, PageSnapshot, PageState, Precondition } from '@runner/domain';
import { RunnerErrors, err, noopLogger, ok } from '@runner/shared';
import {
  ElementVisibleHandler,
  EntityStateHandler,
  UiStateHandler,
  UrlMatchesHandler,
} from '../src/modules/state/page-state-handlers.js';
import type { ElementResolver } from '../src/modules/resolver/element-resolver.js';

/**
 * The rule these tests protect: a handler may only claim to have *prepared* a
 * state it can genuinely reach. Faking preparation turns a missing fixture into
 * a green test, which is precisely what the PRECONDITION_FAILED / TEST_FAILED
 * split exists to prevent.
 *
 * So each handler is checked for two things — that it verifies correctly, and
 * that it refuses to pretend when asked to prepare.
 */

const SESSION = 'bs_1';

function pageState(url: string): PageState {
  return {
    url,
    title: 'Page',
    frameCount: 1,
    hasOpenDialog: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
}

const emptySnapshot: PageSnapshot = {
  url: 'https://app.test/orders',
  capturedAt: '2026-01-01T00:00:00.000Z',
  elements: [],
  frames: [],
  pageMetadata: {},
};

function contextWith(applicationState: readonly string[] = []): ExecutionContext {
  return {
    executionId: 'run_1',
    browserSessionId: SESSION,
    applicationState,
    startedAt: '2026-01-01T00:00:00.000Z',
    plan: { workspaceRef: 'w1' },
  } as unknown as ExecutionContext;
}

function browsersWith(browser: Partial<BrowserPort> | undefined): BrowserManagerPort {
  return {
    get: () => (browser === undefined ? undefined : ({ sessionId: SESSION, ...browser } as BrowserPort)),
  } as unknown as BrowserManagerPort;
}

describe('urlMatches', () => {
  const precondition: Precondition = { type: 'urlMatches', urlPattern: '/orders/*' };

  it('claims only urlMatches preconditions', () => {
    const handler = new UrlMatchesHandler(browsersWith({}), noopLogger);

    expect(handler.canHandle(precondition)).toBe(true);
    expect(handler.canHandle({ type: 'uiState', state: 'X' })).toBe(false);
  });

  it('is satisfied when the page is already there', async () => {
    const handler = new UrlMatchesHandler(
      browsersWith({ getCurrentState: async () => ok(pageState('https://app.test/orders/42')) }),
      noopLogger,
    );

    const satisfied = await handler.isSatisfied(precondition, contextWith());

    expect(satisfied.ok).toBe(true);
    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(true);
  });

  it('is not satisfied elsewhere', async () => {
    const handler = new UrlMatchesHandler(
      browsersWith({ getCurrentState: async () => ok(pageState('https://app.test/login')) }),
      noopLogger,
    );

    const satisfied = await handler.isSatisfied(precondition, contextWith());

    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(false);
  });

  it('refuses to navigate in order to satisfy itself', async () => {
    // Navigating here would skip whatever the test was about to do to get
    // there, and quietly change what the test covers.
    const goto = vi.fn(async () => ok(undefined));
    const handler = new UrlMatchesHandler(
      browsersWith({ goto, getCurrentState: async () => ok(pageState('https://app.test/login')) }),
      noopLogger,
    );

    const prepared = await handler.prepare(precondition, contextWith());

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('PRECONDITION_FAILED');
    expect(goto).not.toHaveBeenCalled();
  });

  it('reports the actual URL alongside the pattern, so the failure is diagnosable', async () => {
    const handler = new UrlMatchesHandler(
      browsersWith({ getCurrentState: async () => ok(pageState('https://app.test/login')) }),
      noopLogger,
    );

    const prepared = await handler.prepare(precondition, contextWith());

    if (prepared.ok) return;
    expect(JSON.stringify(prepared.error.details)).toContain('https://app.test/login');
  });

  it('refuses a precondition with no pattern', async () => {
    const handler = new UrlMatchesHandler(browsersWith({}), noopLogger);

    const satisfied = await handler.isSatisfied({ type: 'urlMatches' }, contextWith());

    expect(satisfied.ok).toBe(false);
    if (satisfied.ok) return;
    expect(satisfied.error.code).toBe('PRECONDITION_FAILED');
  });

  it('fails as a precondition when the browser session has gone', async () => {
    const handler = new UrlMatchesHandler(browsersWith(undefined), noopLogger);

    const satisfied = await handler.isSatisfied(precondition, contextWith());

    expect(satisfied.ok).toBe(false);
    if (satisfied.ok) return;
    expect(satisfied.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('elementVisible', () => {
  const precondition: Precondition = {
    type: 'elementVisible',
    target: { name: 'Order Summary' },
  };

  function resolverThat(found: boolean): ElementResolver {
    return {
      resolve: async () =>
        found
          ? ok({
              runtimeId: 'rt_1',
              confidence: 0.9,
              locator: { type: 'text', value: 'Order Summary' },
              alternatives: [],
              evidence: [],
              resolvedVia: 'CANDIDATE_SCORING',
              matchCount: 1,
            })
          : err(RunnerErrors.elementNotFound('name="Order Summary"')),
    } as unknown as ElementResolver;
  }

  it('is satisfied when the element resolves and is visible', async () => {
    const handler = new ElementVisibleHandler(
      browsersWith({
        inspect: async () => ok(emptySnapshot),
        probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: false }),
      }),
      resolverThat(true),
      noopLogger,
    );

    const satisfied = await handler.isSatisfied(precondition, contextWith());

    expect(satisfied.ok).toBe(true);
    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(true);
  });

  it('treats a missing element as unsatisfied, not as an error', async () => {
    // The element may simply not be on screen yet — which is the question the
    // caller is asking, so it is an answer rather than a failure.
    const handler = new ElementVisibleHandler(
      browsersWith({ inspect: async () => ok(emptySnapshot) }),
      resolverThat(false),
      noopLogger,
    );

    const satisfied = await handler.isSatisfied(precondition, contextWith());

    expect(satisfied.ok).toBe(true);
    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(false);
  });

  it('is not satisfied when the element resolves but is hidden', async () => {
    const handler = new ElementVisibleHandler(
      browsersWith({
        inspect: async () => ok(emptySnapshot),
        probe: async () => ok({ matchCount: 1, visible: false, enabled: true, editable: false }),
      }),
      resolverThat(true),
      noopLogger,
    );

    const satisfied = await handler.isSatisfied(precondition, contextWith());

    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(false);
  });

  it('accepts a visible but disabled element, since visibility is the question', async () => {
    const handler = new ElementVisibleHandler(
      browsersWith({
        inspect: async () => ok(emptySnapshot),
        probe: async () => ok({ matchCount: 1, visible: true, enabled: false, editable: false }),
      }),
      resolverThat(true),
      noopLogger,
    );

    const satisfied = await handler.isSatisfied(precondition, contextWith());

    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(true);
  });

  it('refuses to act in order to reveal the element', async () => {
    const execute = vi.fn();
    const handler = new ElementVisibleHandler(
      browsersWith({ execute } as unknown as Partial<BrowserPort>),
      resolverThat(false),
      noopLogger,
    );

    const prepared = await handler.prepare(precondition, contextWith());

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('PRECONDITION_FAILED');
    expect(prepared.error.message).toContain('Order Summary');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a precondition with no target', async () => {
    const handler = new ElementVisibleHandler(browsersWith({}), resolverThat(true), noopLogger);

    const satisfied = await handler.isSatisfied({ type: 'elementVisible' }, contextWith());

    expect(satisfied.ok).toBe(false);
    if (satisfied.ok) return;
    expect(satisfied.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('uiState', () => {
  const precondition: Precondition = { type: 'uiState', state: 'CART_DRAWER_OPEN' };

  it('is satisfied when the context already records that state', async () => {
    const handler = new UiStateHandler();

    const satisfied = await handler.isSatisfied(
      precondition,
      contextWith(['CART_DRAWER_OPEN']),
    );

    expect(satisfied.ok).toBe(true);
    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(true);
  });

  it('does not infer the state from the page', async () => {
    // Guessing from page content is how a Runner decides a drawer is open
    // because a matching class name appeared somewhere.
    const handler = new UiStateHandler();

    const satisfied = await handler.isSatisfied(precondition, contextWith([]));

    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(false);
  });

  it('says plainly that preparing UI state is not implemented', async () => {
    const handler = new UiStateHandler();

    const prepared = await handler.prepare(precondition, contextWith());

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('CAPABILITY_NOT_IMPLEMENTED');
    expect(prepared.error.message).toContain('CART_DRAWER_OPEN');
  });

  it('refuses a precondition with no state', async () => {
    const handler = new UiStateHandler();

    const satisfied = await handler.isSatisfied({ type: 'uiState' }, contextWith());

    expect(satisfied.ok).toBe(false);
    if (satisfied.ok) return;
    expect(satisfied.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('entityState', () => {
  const precondition: Precondition = {
    type: 'entityState',
    entity: 'ORDER',
    state: 'SUBMITTED',
  };

  it('never claims an entity state it cannot observe', async () => {
    // Answering "satisfied" would let a test run against whatever the database
    // happened to contain and report a green result that means nothing.
    const handler = new EntityStateHandler();

    const satisfied = await handler.isSatisfied(precondition);

    expect(satisfied.ok).toBe(false);
    if (satisfied.ok) return;
    expect(satisfied.error.code).toBe('CAPABILITY_NOT_IMPLEMENTED');
  });

  it('names the entity and state it was asked for', async () => {
    const handler = new EntityStateHandler();

    const prepared = await handler.prepare(precondition);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toContain('ORDER');
    expect(prepared.error.message).toContain('SUBMITTED');
  });

  it('claims only entityState preconditions', () => {
    const handler = new EntityStateHandler();

    expect(handler.canHandle(precondition)).toBe(true);
    expect(handler.canHandle({ type: 'urlMatches', urlPattern: '/x' })).toBe(false);
  });
});
