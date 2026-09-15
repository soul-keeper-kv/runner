import { describe, expect, it, vi } from 'vitest';
import type { StorageStateStorePort, StoredStorageState } from '@runner/application';
import type { LiveSession, RawLiveCommand } from '@runner/live-protocol';
import { RunnerErrors, err, noopLogger, ok } from '@runner/shared';
import { AuthCapability } from '../src/capabilities/auth/auth-capability.js';
import type { LiveSessionContext } from '../src/capabilities/capability-registry.js';
import type { AuthService } from '../src/modules/auth/auth-service.js';

/**
 * What these tests protect, in order:
 *
 *  1. A failed login is a PRECONDITION failure. Nothing here has shown the
 *     application under test to misbehave, and a report that says otherwise
 *     teaches a team to distrust its results.
 *  2. `authenticatedAs` is set from what the Runner *did*, never from the page.
 *  3. A credential never reaches a log, a result or an error payload — this
 *     command arrives from a browser tab.
 *  4. A login is not replayed needlessly: it navigates, and a live session
 *     exists to keep the page that caused the problem.
 */

const WORKSPACE = 'workspace_demo';
const PASSWORD = 'sup3r-s3cret-value';

function sessionWith(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    id: 'ls_test',
    workspaceRef: WORKSPACE,
    browserSessionId: 'bs_1',
    executionState: 'IDLE',
    revision: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeStorageStates(initial?: StoredStorageState) {
  let saved = initial;
  const invalidated: string[] = [];

  const store: StorageStateStorePort = {
    get: async () => ok(saved),
    save: async (entry) => {
      saved = entry;
      return ok(undefined);
    },
    invalidate: async (_workspaceRef, profileRef) => {
      invalidated.push(profileRef);
      saved = undefined;
      return ok(undefined);
    },
  };

  return { store, invalidated };
}

function contextFor(session: LiveSession) {
  const patches: Partial<Pick<LiveSession, 'authenticatedAs'>>[] = [];
  const logged: { message: string; context?: unknown }[] = [];

  const logger = {
    ...noopLogger,
    debug: (message: string, context?: unknown) => logged.push({ message, context }),
    info: (message: string, context?: unknown) => logged.push({ message, context }),
    warn: (message: string, context?: unknown) => logged.push({ message, context }),
    error: (message: string, context?: unknown) => logged.push({ message, context }),
    child: () => logger,
  };

  const context: LiveSessionContext = {
    session,
    browser: { sessionId: 'bs_1' } as LiveSessionContext['browser'],
    logger: logger as never,
    patchSession: (patch) => patches.push(patch),
  };

  return { context, patches, logged };
}

function commandOf(type: string, payload: unknown = {}): RawLiveCommand {
  return { id: 'cmd_1', sessionId: 'ls_test', type, payload };
}

describe('auth.login', () => {
  it('logs in through the service and records what it authenticated as', async () => {
    const authenticate = vi.fn(async () => ok(undefined));
    const states = fakeStorageStates();
    const capability = new AuthCapability(
      { authenticate } as unknown as AuthService,
      states.store,
    );
    const { context, patches } = contextFor(sessionWith({ authProfileRef: 'MANAGER' }));

    const result = await capability.execute(
      commandOf('auth.login', { profileRef: 'MANAGER' }),
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authenticatedAs).toBe('MANAGER');
    expect(authenticate).toHaveBeenCalledWith(
      WORKSPACE,
      'MANAGER',
      expect.anything(),
      'live_ls_test',
    );
    // Reported through the context so the runtime remains the only writer of
    // the session record.
    expect(patches).toEqual([{ authenticatedAs: 'MANAGER' }]);
  });

  it('reports a failed login as a precondition failure, not a test failure', async () => {
    const capability = new AuthCapability(
      {
        authenticate: async () =>
          err(
            RunnerErrors.preconditionFailed(
              'authenticated',
              'Could not find the "Email" field on the login page.',
            ),
          ),
      } as unknown as AuthService,
      fakeStorageStates().store,
    );
    const { context, patches } = contextFor(sessionWith({ authProfileRef: 'MANAGER' }));

    const result = await capability.execute(
      commandOf('auth.login', { profileRef: 'MANAGER' }),
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
    expect(result.error.kind).toBe('PRECONDITION_FAILURE');
    // And it must not claim an authentication that failed.
    expect(patches).toEqual([]);
  });

  it('never lets a credential reach a result, an error or a log', async () => {
    const capability = new AuthCapability(
      {
        authenticate: async () =>
          err(RunnerErrors.preconditionFailed('authenticated', 'Submitting the form failed.')),
      } as unknown as AuthService,
      fakeStorageStates().store,
    );
    const { context, logged } = contextFor(sessionWith({ authProfileRef: 'MANAGER' }));

    const result = await capability.execute(
      // A client that tried to smuggle one in is rejected by the schema at the
      // socket; this pins that nothing here echoes it either.
      commandOf('auth.login', { profileRef: 'MANAGER', password: PASSWORD }),
      context,
    );

    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
  });

  it('does not replay a login the session already performed', async () => {
    // Logging in again navigates to the login page, which would throw away the
    // state the live session exists to preserve.
    const authenticate = vi.fn(async () => ok(undefined));
    const capability = new AuthCapability(
      { authenticate } as unknown as AuthService,
      fakeStorageStates().store,
    );
    const { context } = contextFor(
      sessionWith({ authProfileRef: 'MANAGER', authenticatedAs: 'MANAGER' }),
    );

    const result = await capability.execute(
      commandOf('auth.login', { profileRef: 'MANAGER' }),
      context,
    );

    expect(result.ok).toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('replays the login when forced, for a session the app signed out', async () => {
    const authenticate = vi.fn(async () => ok(undefined));
    const capability = new AuthCapability(
      { authenticate } as unknown as AuthService,
      fakeStorageStates().store,
    );
    const { context } = contextFor(
      sessionWith({ authProfileRef: 'MANAGER', authenticatedAs: 'MANAGER' }),
    );

    await capability.execute(
      commandOf('auth.login', { profileRef: 'MANAGER', force: true }),
      context,
    );

    expect(authenticate).toHaveBeenCalled();
  });

  it('refuses a login that names no profile', async () => {
    const capability = new AuthCapability(
      { authenticate: async () => ok(undefined) } as unknown as AuthService,
      fakeStorageStates().store,
    );
    const { context } = contextFor(sessionWith());

    const result = await capability.execute(commandOf('auth.login', {}), context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('auth.status', () => {
  it('reports the session as unauthenticated without touching the page', async () => {
    const capability = new AuthCapability(
      { authenticate: async () => ok(undefined) } as unknown as AuthService,
      fakeStorageStates().store,
    );
    const { context } = contextFor(sessionWith({ authProfileRef: 'MANAGER' }));

    const result = await capability.execute(commandOf('auth.status'), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authenticatedAs).toBeUndefined();
    expect(result.value.profileRef).toBe('MANAGER');
  });

  it('reports a restored session, including when it expires', async () => {
    const states = fakeStorageStates({
      workspaceRef: WORKSPACE,
      profileRef: 'MANAGER',
      state: { cookies: [] },
      capturedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T08:00:00.000Z',
    });
    const capability = new AuthCapability(
      { authenticate: async () => ok(undefined) } as unknown as AuthService,
      states.store,
    );
    const { context } = contextFor(
      sessionWith({ authProfileRef: 'MANAGER', authenticatedAs: 'MANAGER' }),
    );

    const result = await capability.execute(commandOf('auth.status'), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authenticatedAs).toBe('MANAGER');
    expect(result.value.fromStoredSession).toBe(true);
    expect(result.value.expiresAt).toBe('2026-01-01T08:00:00.000Z');
  });

  it('answers for a session that never named a profile', async () => {
    const capability = new AuthCapability(
      { authenticate: async () => ok(undefined) } as unknown as AuthService,
      fakeStorageStates().store,
    );
    const { context } = contextFor(sessionWith());

    const result = await capability.execute(commandOf('auth.status'), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fromStoredSession).toBe(false);
    expect(result.value.profileRef).toBeUndefined();
  });
});

describe('auth.logout', () => {
  it('invalidates the stored session so the next login is a real one', async () => {
    const states = fakeStorageStates({
      workspaceRef: WORKSPACE,
      profileRef: 'MANAGER',
      state: { cookies: [] },
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    const capability = new AuthCapability(
      { authenticate: async () => ok(undefined) } as unknown as AuthService,
      states.store,
    );
    const { context, patches } = contextFor(
      sessionWith({ authProfileRef: 'MANAGER', authenticatedAs: 'MANAGER' }),
    );

    const result = await capability.execute(commandOf('auth.logout'), context);

    expect(result.ok).toBe(true);
    expect(states.invalidated).toEqual(['MANAGER']);
    expect(patches).toEqual([{ authenticatedAs: undefined }]);
  });
});
