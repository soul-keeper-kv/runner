import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserCookie,
  BrowserPort,
  ExecutionProfile,
  HttpClientPort,
  OriginStorageSeed,
  SecretProviderPort,
  StorageStateStorePort,
} from '@runner/application';
import { fixedClock, noopLogger, ok, err, RunnerErrors } from '@runner/shared';
import { AuthService } from '../src/modules/auth/auth-service.js';
import type { ElementResolver } from '../src/modules/resolver/element-resolver.js';

/**
 * Token authentication, and the free-form headers that go with it.
 *
 * What these protect, in order:
 *
 *  1. **A token ends up where the application actually looks.** Placement is
 *     configuration, never a guess: an SPA reads `localStorage` during
 *     bootstrap, a server-rendered app reads a cookie, an API-first one wants
 *     the header. A profile naming none is refused, because the alternative is
 *     a login that reports success while every page shows the sign-in screen.
 *  2. **A token never reaches a log, a result or an error payload.** It is a
 *     bearer credential — anyone holding it is authenticated.
 *  3. **A refusal from a login endpoint is a PRECONDITION failure.** Nothing
 *     about the application under test has been shown to be wrong.
 */

const WORKSPACE = 'workspace_demo';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-token.signature';
const PASSWORD = 'sup3r-s3cret-value';

function tokenProfile(overrides: Partial<ExecutionProfile> = {}): ExecutionProfile {
  return {
    ref: 'CARIS',
    workspaceRef: WORKSPACE,
    displayName: 'CARIS admin',
    strategy: 'API_TOKEN',
    loginUrl: 'https://app.test/login/',
    secretRefs: { token: 'CARIS_TOKEN' },
    tokenSource: { kind: 'static', secretRef: 'CARIS_TOKEN' },
    tokenPlacements: [{ kind: 'header' }],
    ...overrides,
  };
}

function fakeSecrets(
  profile: ExecutionProfile,
  values: Record<string, string> = { CARIS_TOKEN: TOKEN, CARIS_PASS: PASSWORD },
): SecretProviderPort {
  return {
    getProfile: async () => ok(profile),
    resolveSecrets: async () =>
      ok(
        Object.fromEntries(
          Object.entries(values).map(([ref, value]) => [ref, { ref, value }]),
        ),
      ),
  };
}

/** Records every way a token could have been placed. */
function fakeBrowser(overrides: Partial<BrowserPort> = {}) {
  const headers: Record<string, string>[] = [];
  const cookies: BrowserCookie[][] = [];
  const storage: OriginStorageSeed[] = [];

  const browser = {
    sessionId: 'bs_token',
    goto: async () => ok(undefined),
    setExtraHeaders: async (value: Record<string, string>) => {
      headers.push(value);
      return ok(undefined);
    },
    addCookies: async (value: readonly BrowserCookie[]) => {
      cookies.push([...value]);
      return ok(undefined);
    },
    seedOriginStorage: async (value: OriginStorageSeed) => {
      storage.push(value);
      return ok(undefined);
    },
    captureStorageState: async () => ok({ cookies: [], origins: [] }),
    ...overrides,
  } as unknown as BrowserPort;

  return { browser, headers, cookies, storage };
}

function serviceWith(options: {
  profile?: ExecutionProfile;
  secrets?: SecretProviderPort;
  http?: HttpClientPort;
  values?: Record<string, string>;
}) {
  const profile = options.profile ?? tokenProfile();
  const logged: unknown[] = [];

  const logger = {
    ...noopLogger,
    debug: (message: string, context?: unknown) => logged.push({ message, context }),
    info: (message: string, context?: unknown) => logged.push({ message, context }),
    warn: (message: string, context?: unknown) => logged.push({ message, context }),
    error: (message: string, context?: unknown) => logged.push({ message, context }),
    child: () => logger,
  };

  const storageStates: StorageStateStorePort = {
    get: async () => ok(undefined),
    save: async () => ok(undefined),
    invalidate: async () => ok(undefined),
  };

  const auth = new AuthService({
    secrets: options.secrets ?? fakeSecrets(profile, options.values),
    storageStates,
    resolver: { resolve: async () => err(RunnerErrors.elementNotFound('unused')) } as unknown as ElementResolver,
    clock: fixedClock('2026-01-01T00:00:00.000Z'),
    logger: logger as never,
    ...(options.http === undefined ? {} : { http: options.http }),
  });

  return { auth, logged, profile };
}

describe('placing a token', () => {
  it('sends it as a bearer header by default', async () => {
    const { auth } = serviceWith({});
    const { browser, headers } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(result.ok).toBe(true);
    expect(headers).toEqual([{ Authorization: `Bearer ${TOKEN}` }]);
  });

  it('honours a custom header name and prefix', async () => {
    const { auth } = serviceWith({
      profile: tokenProfile({
        tokenPlacements: [{ kind: 'header', name: 'X-Auth-Token', prefix: '' }],
      }),
    });
    const { browser, headers } = fakeBrowser();

    await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(headers).toEqual([{ 'X-Auth-Token': TOKEN }]);
  });

  it('writes it into localStorage for the profile origin', async () => {
    // How an SPA actually reads a session: the origin matters, because storage
    // is origin-scoped and a token written elsewhere is written nowhere.
    const { auth } = serviceWith({
      profile: tokenProfile({
        tokenPlacements: [{ kind: 'localStorage', key: 'access_token' }],
      }),
    });
    const { browser, storage } = fakeBrowser();

    await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(storage).toEqual([
      {
        origin: 'https://app.test',
        storage: 'localStorage',
        entries: { access_token: TOKEN },
      },
    ]);
  });

  it('wraps it in the JSON envelope an app expects', async () => {
    /*
     * The CARIS case, and a common one: a Zustand-persisted store keeps
     * `{"state":{...},"version":0}`, and a bare token in that slot reads as a
     * corrupt session rather than as a login.
     */
    const { auth } = serviceWith({
      profile: tokenProfile({
        tokenPlacements: [
          {
            kind: 'localStorage',
            key: 'auth-storage',
            jsonTemplate: '{"state":{"token":"{{token}}"},"version":0}',
          },
        ],
      }),
    });
    const { browser, storage } = fakeBrowser();

    await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(storage[0]?.entries['auth-storage']).toBe(
      `{"state":{"token":"${TOKEN}"},"version":0}`,
    );
  });

  it('places it as a cookie on the profile origin', async () => {
    const { auth } = serviceWith({
      profile: tokenProfile({ tokenPlacements: [{ kind: 'cookie', name: 'session' }] }),
    });
    const { browser, cookies } = fakeBrowser();

    await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(cookies[0]?.[0]).toMatchObject({
      name: 'session',
      value: TOKEN,
      url: 'https://app.test',
      path: '/',
    });
  });

  it('applies every placement when an app needs more than one', async () => {
    // Common while an application migrates from one mechanism to another.
    const { auth } = serviceWith({
      profile: tokenProfile({
        tokenPlacements: [
          { kind: 'header' },
          { kind: 'localStorage', key: 'access_token' },
          { kind: 'cookie', name: 'session' },
        ],
      }),
    });
    const { browser, headers, storage, cookies } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(result.ok).toBe(true);
    expect(headers).toHaveLength(1);
    expect(storage).toHaveLength(1);
    expect(cookies).toHaveLength(1);
  });

  it('refuses a profile that names no placement', async () => {
    // The failure this prevents is the worst one available here: a login that
    // succeeds while every page still shows the sign-in screen.
    const { auth } = serviceWith({ profile: tokenProfile({ tokenPlacements: [] }) });
    const { browser } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
    expect(result.error.message).toContain('no token placement');
  });

  it('refuses storage placement when no origin can be determined', async () => {
    const { auth } = serviceWith({
      profile: tokenProfile({
        loginUrl: undefined,
        tokenPlacements: [{ kind: 'localStorage', key: 'access_token' }],
      }),
    });
    const { browser } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('origin');
  });

  it('refuses a profile that says where no token comes from', async () => {
    const { auth } = serviceWith({ profile: tokenProfile({ tokenSource: undefined }) });
    const { browser } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('exchanging credentials for a token', () => {
  function fakeHttp(response: { status: number; body: string }) {
    const sent: { url: string; body?: string; headers?: Record<string, string> }[] = [];

    const http: HttpClientPort = {
      send: async (request) => {
        sent.push({
          url: request.url,
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
        });
        return ok({ status: response.status, headers: {}, body: response.body });
      },
    };

    return { http, sent };
  }

  const apiLoginProfile = tokenProfile({
    secretRefs: { username: 'CARIS_USER', password: 'CARIS_PASS' },
    tokenSource: {
      kind: 'apiLogin',
      url: 'https://app.test/api/auth/login',
      bodyTemplate: '{"username":"{{CARIS_USER}}","password":"{{CARIS_PASS}}"}',
      tokenPath: 'data.access_token',
    },
    tokenPlacements: [{ kind: 'header' }],
  });

  it('posts the filled template and places the token it returns', async () => {
    const { http, sent } = fakeHttp({
      status: 200,
      body: JSON.stringify({ data: { access_token: TOKEN } }),
    });
    const { auth } = serviceWith({
      profile: apiLoginProfile,
      secrets: fakeSecrets(apiLoginProfile, {
        CARIS_USER: 'admin@test',
        CARIS_PASS: PASSWORD,
      }),
      http,
    });
    const { browser, headers } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(result.ok).toBe(true);
    expect(sent[0]?.url).toBe('https://app.test/api/auth/login');
    expect(sent[0]?.body).toBe(`{"username":"admin@test","password":"${PASSWORD}"}`);
    expect(headers).toEqual([{ Authorization: `Bearer ${TOKEN}` }]);
  });

  it('escapes a credential so a quote cannot break the body', async () => {
    // Otherwise the endpoint answers "bad credentials" for what is really a
    // malformed JSON body — a failure that blames the password.
    const { http, sent } = fakeHttp({
      status: 200,
      body: JSON.stringify({ data: { access_token: TOKEN } }),
    });
    const { auth } = serviceWith({
      profile: apiLoginProfile,
      secrets: fakeSecrets(apiLoginProfile, {
        CARIS_USER: 'admin@test',
        CARIS_PASS: 'pa"ss\\word',
      }),
      http,
    });

    await auth.authenticate(WORKSPACE, 'CARIS', fakeBrowser().browser, 'run_1');

    expect(() => JSON.parse(sent[0]?.body ?? '')).not.toThrow();
    expect(JSON.parse(sent[0]!.body!).password).toBe('pa"ss\\word');
  });

  it('reports a refusal as a precondition failure, with the status', async () => {
    const { http } = fakeHttp({ status: 401, body: '{"message":"bad credentials"}' });
    const { auth } = serviceWith({
      profile: apiLoginProfile,
      secrets: fakeSecrets(apiLoginProfile, { CARIS_USER: 'x', CARIS_PASS: 'y' }),
      http,
    });

    const result = await auth.authenticate(WORKSPACE, 'CARIS', fakeBrowser().browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRECONDITION_FAILED');
    expect(result.error.kind).toBe('PRECONDITION_FAILURE');
    expect(result.error.message).toContain('401');
  });

  it('names the path when the token is not where the profile said', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: JSON.stringify({ data: { refresh_token: 'other' } }),
    });
    const { auth } = serviceWith({
      profile: apiLoginProfile,
      secrets: fakeSecrets(apiLoginProfile, { CARIS_USER: 'x', CARIS_PASS: 'y' }),
      http,
    });

    const result = await auth.authenticate(WORKSPACE, 'CARIS', fakeBrowser().browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Naming the path is what makes this fixable; dumping the body would put
    // the credential just sent into a log.
    expect(result.error.message).toContain('data.access_token');
  });

  it('refuses when no HTTP client is bound, rather than appearing to try', async () => {
    const { auth } = serviceWith({
      profile: apiLoginProfile,
      secrets: fakeSecrets(apiLoginProfile, { CARIS_USER: 'x', CARIS_PASS: 'y' }),
    });

    const result = await auth.authenticate(WORKSPACE, 'CARIS', fakeBrowser().browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CAPABILITY_NOT_IMPLEMENTED');
  });
});

describe('keeping a token out of the record', () => {
  it('never logs it', async () => {
    const { auth, logged } = serviceWith({});
    const { browser } = fakeBrowser();

    await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  it('never puts it in an error payload', async () => {
    const { auth } = serviceWith({
      profile: tokenProfile({ tokenPlacements: [{ kind: 'header' }] }),
    });
    const { browser } = fakeBrowser({
      setExtraHeaders: async () => err(RunnerErrors.internal('context closed')),
    });

    const result = await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error.toJSON())).not.toContain(TOKEN);
  });
});

describe('free-form headers', () => {
  it('applies literal headers for any strategy', async () => {
    // An internal app often needs a tenant id or an API version before it will
    // answer at all — including on the login request itself.
    const { auth } = serviceWith({
      profile: tokenProfile({
        extraHeaders: [
          { name: 'X-Tenant', value: 'acme' },
          { name: 'X-Api-Version', value: '2024-06' },
        ],
      }),
    });
    const { browser, headers } = fakeBrowser();

    const result = await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(result.ok).toBe(true);
    expect(headers[0]).toEqual({ 'X-Tenant': 'acme', 'X-Api-Version': '2024-06' });
  });

  it('resolves a header value from a secret', async () => {
    const { auth } = serviceWith({
      profile: tokenProfile({
        secretRefs: { token: 'CARIS_TOKEN', apiKey: 'CARIS_PASS' },
        extraHeaders: [{ name: 'X-Api-Key', secretRef: 'CARIS_PASS' }],
      }),
    });
    const { browser, headers } = fakeBrowser();

    await auth.authenticate(WORKSPACE, 'CARIS', browser, 'run_1');

    expect(headers[0]).toEqual({ 'X-Api-Key': PASSWORD });
  });

  it('warns that a credential-bearing header reaches every origin', async () => {
    /*
     * Not a hypothetical: a context header goes to every host the page talks
     * to, including a CDN or an analytics endpoint, because that is how
     * browsers work and Playwright does not filter by origin. The warning is
     * the honest answer — the alternative is a silent credential leak.
     */
    const { auth, logged } = serviceWith({
      profile: tokenProfile({
        extraHeaders: [{ name: 'X-Api-Key', secretRef: 'CARIS_PASS' }],
      }),
    });

    await auth.authenticate(WORKSPACE, 'CARIS', fakeBrowser().browser, 'run_1');

    const text = JSON.stringify(logged);
    expect(text).toContain('every origin');
    expect(text).toContain('X-Api-Key');
    // The name is logged; the value never is.
    expect(text).not.toContain(PASSWORD);
  });

  it('refuses a header with neither a value nor a secret', async () => {
    const { auth } = serviceWith({
      profile: tokenProfile({ extraHeaders: [{ name: 'X-Broken' }] }),
    });

    const result = await auth.authenticate(WORKSPACE, 'CARIS', fakeBrowser().browser, 'run_1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });
});
