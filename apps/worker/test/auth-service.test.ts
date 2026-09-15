import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserManagerPort,
  BrowserPort,
  ExecutionProfile,
  SecretProviderPort,
  StorageStateStorePort,
  StoredStorageState,
} from '@runner/application';
import type { ExecutionContext, PageSnapshot, Precondition } from '@runner/domain';
import { RunnerErrors, err, fixedClock, noopLogger, ok } from '@runner/shared';
import { AuthService } from '../src/modules/auth/auth-service.js';
import { AuthenticatedStateHandler } from '../src/modules/auth/authenticated-state-handler.js';
import type { ElementResolver } from '../src/modules/resolver/element-resolver.js';

/**
 * What these tests protect, in order of importance:
 *
 *  1. A credential never reaches a log, an error payload or the timeline.
 *  2. A login that cannot be performed is a PRECONDITION failure, never a test
 *     failure — a team must be able to tell a broken fixture from a broken app.
 *  3. A stored session is reused, so a UI login happens once rather than per run.
 *
 * Everything is faked through ports; no browser launches.
 */

const WORKSPACE = 'workspace_demo';
const PASSWORD = 'sup3r-s3cret-value';

function formLoginProfile(overrides: Partial<ExecutionProfile> = {}): ExecutionProfile {
  return {
    ref: 'MANAGER',
    workspaceRef: WORKSPACE,
    displayName: 'Store manager',
    strategy: 'FORM_LOGIN',
    loginUrl: 'https://app.test/login',
    formFields: { username: 'Email', password: 'Password', submit: 'Login' },
    secretRefs: { username: 'MANAGER_USER', password: 'MANAGER_PASS' },
    ...overrides,
  };
}

function fakeSecrets(profile: ExecutionProfile): SecretProviderPort {
  return {
    getProfile: async () => ok(profile),
    resolveSecrets: async () =>
      ok({
        MANAGER_USER: { ref: 'MANAGER_USER', value: 'manager@example.com' },
        MANAGER_PASS: { ref: 'MANAGER_PASS', value: PASSWORD },
      }),
  };
}

function fakeStorageStates(initial?: StoredStorageState) {
  let saved = initial;
  const store: StorageStateStorePort = {
    get: async () => ok(saved),
    save: async (entry) => {
      saved = entry;
      return ok(undefined);
    },
    invalidate: async () => {
      saved = undefined;
      return ok(undefined);
    },
  };
  return {
    store,
    get saved() {
      return saved;
    },
  };
}

const snapshot: PageSnapshot = {
  url: 'https://app.test/login',
  capturedAt: '2026-01-01T00:00:00.000Z',
  elements: [],
  frames: [],
  pageMetadata: {},
};

function fakeResolver(): ElementResolver {
  return {
    resolve: async () =>
      ok({
        runtimeId: 'rt_1',
        confidence: 0.97,
        locator: { type: 'role', role: 'textbox', name: 'Email' },
        alternatives: [],
        evidence: [],
        resolvedVia: 'CANDIDATE_SCORING',
        matchCount: 1,
      }),
  } as unknown as ElementResolver;
}

/** Records every action the login drove, so filled values can be inspected. */
function fakeBrowser(overrides: Partial<BrowserPort> = {}) {
  const executed: { type: string; value?: unknown }[] = [];

  const browser = {
    sessionId: 'bs_auth',
    goto: async () => ok(undefined),
    inspect: async () => ok(snapshot),
    execute: async (action: { type: string; value?: unknown }) => {
      executed.push({ type: action.type, value: action.value });
      return ok({ status: 'PASSED', durationMs: 1, evidence: [], artifactIds: [] });
    },
    captureStorageState: async () => ok({ cookies: [{ name: 'session', value: 'abc' }] }),
    ...overrides,
  } as unknown as BrowserPort;

  return { browser, executed };
}

function serviceWith(options: {
  profile?: ExecutionProfile;
  stored?: StoredStorageState;
  secrets?: SecretProviderPort;
}) {
  const clock = fixedClock('2026-01-01T00:00:00.000Z');
  const profile = options.profile ?? formLoginProfile();
  const storageStates = fakeStorageStates(options.stored);

  const logged: { message: string; context?: unknown }[] = [];
  const logger = {
    ...noopLogger,
    debug: (message: string, context?: unknown) => logged.push({ message, context }),
    info: (message: string, context?: unknown) => logged.push({ message, context }),
    warn: (message: string, context?: unknown) => logged.push({ message, context }),
    error: (message: string, context?: unknown) => logged.push({ message, context }),
    child: () => logger,
  };

  const auth = new AuthService({
    secrets: options.secrets ?? fakeSecrets(profile),
    storageStates: storageStates.store,
    resolver: fakeResolver(),
    clock,
    logger: logger as never,
  });

  return { auth, storageStates, logged, clock };
}

describe('reusing a stored session', () => {
  it('returns stored state so a run starts already authenticated', async () => {
    const { auth } = serviceWith({
      stored: {
        workspaceRef: WORKSPACE,
        profileRef: 'MANAGER',
        state: { cookies: [{ name: 'session', value: 'reused' }] },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const state = await auth.storageStateFor(WORKSPACE, 'MANAGER');

    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value).toEqual({ cookies: [{ name: 'session', value: 'reused' }] });
  });

  it('reports no stored session as absent, not as an error', async () => {
    // A cache miss means "log in again", which is normal.
    const { auth } = serviceWith({});

    const state = await auth.storageStateFor(WORKSPACE, 'MANAGER');

    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value).toBeUndefined();
  });
});

describe('form login', () => {
  it('fills the named fields and submits, then captures the session', async () => {
    const { auth, storageStates } = serviceWith({});
    const { browser, executed } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    expect(result.ok).toBe(true);
    expect(executed.map((entry) => entry.type)).toEqual(['fill', 'fill', 'click']);
    // Captured only after the login completed, so a stored session is never one
    // that merely reached the login page.
    expect(storageStates.saved?.state).toEqual({
      cookies: [{ name: 'session', value: 'abc' }],
    });
    expect(storageStates.saved?.expiresAt).toBeDefined();
  });

  it('never writes a credential to a log', async () => {
    const { auth, logged } = serviceWith({});
    const { browser } = fakeBrowser();

    await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    const everythingLogged = JSON.stringify(logged);
    expect(everythingLogged).not.toContain(PASSWORD);
    expect(everythingLogged).not.toContain('manager@example.com');
  });

  it('never puts a credential in an error payload', async () => {
    const { auth } = serviceWith({});
    const { browser } = fakeBrowser({
      execute: async () => err(RunnerErrors.actionFailed('fill', 'element detached')),
    });

    const result = await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error.toJSON())).not.toContain(PASSWORD);
  });

  it('reports a login failure as a precondition failure, not a test failure', async () => {
    // This is the distinction the whole phase turns on: the app under test has
    // not been shown to misbehave.
    const { auth } = serviceWith({});
    const { browser } = fakeBrowser({
      goto: async () => err(RunnerErrors.pageNotReachable('https://app.test/login', 'timeout')),
    });

    const result = await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
    expect(result.error.kind).toBe('PRECONDITION_FAILURE');
  });

  it('refuses a FORM_LOGIN profile with no loginUrl', async () => {
    const profile = formLoginProfile({ loginUrl: undefined });
    const { auth } = serviceWith({ profile, secrets: fakeSecrets(profile) });
    const { browser } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });

  it('names the missing secret key without revealing any value', async () => {
    const profile = formLoginProfile();
    const { auth } = serviceWith({
      profile,
      secrets: {
        getProfile: async () => ok(profile),
        resolveSecrets: async () =>
          err(
            RunnerErrors.preconditionFailed(
              'authenticated',
              'Missing credential environment variable(s): MANAGER_PASS.',
              { profileRef: 'MANAGER', missing: ['MANAGER_PASS'] },
            ),
          ),
      },
    });
    const { browser } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('MANAGER_PASS');
    expect(JSON.stringify(result.error.toJSON())).not.toContain(PASSWORD);
  });

  it('treats a login that worked but could not be cached as a success', async () => {
    // The next run simply logs in again; failing here would turn a cache
    // problem into a test failure.
    const { auth } = serviceWith({});
    const { browser } = fakeBrowser({
      captureStorageState: async () => err(RunnerErrors.internal('context closed')),
    });

    const result = await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    expect(result.ok).toBe(true);
  });

  it('refuses a strategy it has not implemented, naming it', async () => {
    const profile = formLoginProfile({ strategy: 'OAUTH' });
    const { auth } = serviceWith({ profile, secrets: fakeSecrets(profile) });
    const { browser } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CAPABILITY_NOT_IMPLEMENTED');
    expect(result.error.message).toContain('OAUTH');
  });

  it('refuses STORAGE_STATE when nothing has been stored', async () => {
    const profile = formLoginProfile({ strategy: 'STORAGE_STATE' });
    const { auth } = serviceWith({ profile, secrets: fakeSecrets(profile) });
    const { browser } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'MANAGER', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('the authenticated precondition handler', () => {
  function contextWith(authenticatedAs?: string): ExecutionContext {
    return {
      executionId: 'run_1',
      browserSessionId: 'bs_auth',
      applicationState: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      ...(authenticatedAs === undefined ? {} : { authenticatedAs }),
      plan: { workspaceRef: WORKSPACE },
    } as unknown as ExecutionContext;
  }

  function handlerWith(
    browser: BrowserPort | undefined,
    authenticate = vi.fn(async () => ok(undefined)),
    stored?: StoredStorageState,
  ) {
    const browsers = { get: () => browser } as unknown as BrowserManagerPort;
    const auth = { authenticate } as unknown as AuthService;
    // The handler consults the session store, because a completed login is what
    // creates one — `prepare` cannot write to the immutable ExecutionContext.
    const states = fakeStorageStates(stored);
    return {
      handler: new AuthenticatedStateHandler(auth, browsers, states.store, noopLogger),
      authenticate,
      states,
    };
  }

  const precondition: Precondition = { type: 'authenticated', profile: 'MANAGER' };

  it('claims only authenticated preconditions', () => {
    const { handler } = handlerWith(fakeBrowser().browser);

    expect(handler.canHandle(precondition)).toBe(true);
    expect(handler.canHandle({ type: 'uiState', state: 'CART_OPEN' })).toBe(false);
  });

  it('is already satisfied when the context is authenticated as that profile', async () => {
    const { handler } = handlerWith(fakeBrowser().browser);

    const satisfied = await handler.isSatisfied(precondition, contextWith('MANAGER'));

    expect(satisfied.ok).toBe(true);
    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(true);
  });

  it('is not satisfied when authenticated as a different profile', async () => {
    const { handler } = handlerWith(fakeBrowser().browser);

    const satisfied = await handler.isSatisfied(precondition, contextWith('VIEWER'));

    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(false);
  });

  it('does not guess from page content', async () => {
    // Nothing is probed: concluding "logged in" because the word Logout appears
    // somewhere is how a Runner runs a whole suite against a login page.
    const { browser } = fakeBrowser();
    const inspect = vi.fn(async () => ok(snapshot));
    const { handler } = handlerWith({ ...browser, inspect } as unknown as BrowserPort);

    await handler.isSatisfied(precondition, contextWith(undefined));

    expect(inspect).not.toHaveBeenCalled();
  });

  it('refuses a precondition that names no profile', async () => {
    const { handler } = handlerWith(fakeBrowser().browser);

    const satisfied = await handler.isSatisfied({ type: 'authenticated' }, contextWith());

    expect(satisfied.ok).toBe(false);
    if (satisfied.ok) return;
    expect(satisfied.error.code).toBe('PRECONDITION_FAILED');
  });

  it('authenticates through the service when preparing', async () => {
    const { handler, authenticate } = handlerWith(fakeBrowser().browser);

    const prepared = await handler.prepare(precondition, contextWith());

    expect(prepared.ok).toBe(true);
    expect(authenticate).toHaveBeenCalledWith(WORKSPACE, 'MANAGER', expect.anything(), 'run_1');
  });

  it('fails as a precondition when the browser session has gone', async () => {
    const { handler } = handlerWith(undefined);

    const prepared = await handler.prepare(precondition, contextWith());

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('PRECONDITION_FAILED');
  });

  it('reports satisfied after its own login, which the engine re-checks', async () => {
    /*
     * The bug this pins. `PreconditionEngine` calls isSatisfied, prepare, then
     * isSatisfied again — with the *same* immutable ExecutionContext. A handler
     * that judged only by `context.authenticatedAs` could never see its own
     * login, so every authenticated run failed with "the state was prepared but
     * the precondition is still not satisfied". Only a real browser showed it.
     */
    const session: StoredStorageState = {
      workspaceRef: WORKSPACE,
      profileRef: 'MANAGER',
      state: { cookies: [] },
      capturedAt: '2026-01-01T00:00:00.000Z',
    };

    // A login that stores a session, exactly as AuthService does.
    const authenticate = vi.fn(async () => {
      await states.store.save(session);
      return ok(undefined);
    });

    const browsers = { get: () => fakeBrowser().browser } as unknown as BrowserManagerPort;
    const states = fakeStorageStates(undefined);
    const handler = new AuthenticatedStateHandler(
      { authenticate } as unknown as AuthService,
      browsers,
      states.store,
      noopLogger,
    );

    const context = contextWith(undefined);

    const before = await handler.isSatisfied(precondition, context);
    expect(before.ok && before.value).toBe(false);

    expect((await handler.prepare(precondition, context)).ok).toBe(true);

    const after = await handler.isSatisfied(precondition, context);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value).toBe(true);
  });

  it('is satisfied when a stored session already exists', async () => {
    const { handler } = handlerWith(fakeBrowser().browser, vi.fn(async () => ok(undefined)), {
      workspaceRef: WORKSPACE,
      profileRef: 'MANAGER',
      state: { cookies: [] },
      capturedAt: '2026-01-01T00:00:00.000Z',
    });

    const satisfied = await handler.isSatisfied(precondition, contextWith(undefined));

    expect(satisfied.ok).toBe(true);
    if (!satisfied.ok) return;
    expect(satisfied.value).toBe(true);
  });
});
