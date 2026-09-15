import type {
  BrowserCookie,
  BrowserPort,
  ExecutionProfile,
  HttpClientPort,
  ProfileHeader,
  ResolvedSecret,
  SecretProviderPort,
  StorageStateStorePort,
  TokenPlacement,
} from '@runner/application';
import type { ElementIntent, PageSnapshot, TestAction } from '@runner/domain';
import type { ScopedSelector } from '@runner/selector-model';
import { RunnerErrors, err, ok, type Clock, type Logger, type Result } from '@runner/shared';
import type { ElementResolver } from '../resolver/element-resolver.js';

/**
 * Performs and reuses authentication (blueprint sections 9 and 50).
 *
 * Three rules shape everything here:
 *
 *  - **A password never leaves this flow.** It is resolved from the secret
 *    provider for one login, typed into the page, and never logged, never
 *    stored, never attached to an error. Evidence records *that* a field was
 *    filled, never with what.
 *  - **Log in once.** The state a successful login produced is captured and
 *    reused, so a login-page change breaks one fixture rather than every test.
 *  - **A failed login is a PRECONDITION failure, not a test failure.** If the
 *    Runner cannot authenticate, the application under test has not been shown
 *    to be wrong, and a report must not say it was.
 *
 * The login itself is driven entirely through `BrowserPort` — the same actions
 * an ordinary step uses — so this module contains no Playwright and works
 * against any engine behind the port.
 */

export interface AuthServiceDeps {
  readonly secrets: SecretProviderPort;
  readonly storageStates: StorageStateStorePort;
  readonly resolver: ElementResolver;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Absent when no HTTP client is bound; an `apiLogin` token source then
   * reports that precisely rather than failing to reach an endpoint it never
   * tried to call.
   */
  readonly http?: HttpClientPort;
}

/** How long a captured session is trusted before the login is replayed. */
const DEFAULT_STATE_TTL_MS = 8 * 60 * 60 * 1000;

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * Returns storage state for a profile, if any is worth reusing.
   *
   * Called before a browser launches, so an authenticated run starts already
   * logged in. A miss is not an error: the caller launches unauthenticated and
   * the precondition handler performs the login.
   */
  async storageStateFor(
    workspaceRef: string,
    profileRef: string,
  ): Promise<Result<unknown | undefined>> {
    const stored = await this.deps.storageStates.get(workspaceRef, profileRef);
    if (!stored.ok) return stored;

    if (stored.value === undefined) {
      this.deps.logger.debug('No stored session for profile', { profileRef });
      return ok(undefined);
    }

    this.deps.logger.debug('Reusing a stored session', {
      profileRef,
      capturedAt: stored.value.capturedAt,
    });
    return ok(stored.value.state);
  }

  /**
   * Authenticates the browser as `profileRef`, then captures the result.
   *
   * Only `FORM_LOGIN` and `STORAGE_STATE` are implemented. The others report
   * `CAPABILITY_NOT_IMPLEMENTED` naming the strategy rather than silently
   * continuing unauthenticated, which would surface later as a confusing
   * assertion failure on a login page.
   */
  async authenticate(
    workspaceRef: string,
    profileRef: string,
    browser: BrowserPort,
    executionId: string,
  ): Promise<Result<void>> {
    const profile = await this.deps.secrets.getProfile(workspaceRef, profileRef);
    if (!profile.ok) return profile;

    /*
     * Headers first, and for every strategy.
     *
     * An internal application usually needs more than a credential to answer at
     * all — a tenant id, an API version, a feature flag — and those have to be
     * in place before the login request, not after it. Applying them here means
     * a FORM_LOGIN profile can carry them too.
     */
    const headers = await this.applyExtraHeaders(profile.value, browser, executionId);
    if (!headers.ok) return headers;

    switch (profile.value.strategy) {
      case 'FORM_LOGIN':
        return this.formLogin(profile.value, browser, executionId);

      case 'API_TOKEN':
        return this.tokenLogin(profile.value, browser, executionId);

      case 'STORAGE_STATE': {
        // The state is applied at launch, so by the time this runs the context
        // either already carries it or there was none to apply.
        const stored = await this.deps.storageStates.get(workspaceRef, profileRef);
        if (!stored.ok) return stored;
        if (stored.value === undefined) {
          return err(
            RunnerErrors.preconditionFailed(
              'authenticated',
              `Profile "${profileRef}" uses STORAGE_STATE but no session has been stored for it.`,
              { profileRef },
            ),
          );
        }
        return ok(undefined);
      }

      default:
        return err(
          RunnerErrors.capabilityNotImplemented(
            `Authentication strategy ${profile.value.strategy} (FORM_LOGIN, API_TOKEN and STORAGE_STATE are implemented)`,
          ),
        );
    }
  }

  /**
   * Authenticates by putting a token where the application looks for it.
   *
   * The token is obtained once and then *placed*, possibly in several places at
   * once. Placement is configuration rather than a guess because there is no
   * portable answer: an SPA reads `localStorage` during bootstrap, a
   * server-rendered app reads a cookie, an API-first one wants the header. A
   * wrong guess produces the worst outcome available here — a login that
   * reports success while every page still shows the sign-in screen — so a
   * profile that names no placement is refused rather than defaulted.
   */
  private async tokenLogin(
    profile: ExecutionProfile,
    browser: BrowserPort,
    executionId: string,
  ): Promise<Result<void>> {
    const placements = profile.tokenPlacements ?? [];

    if (placements.length === 0) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Profile "${profile.ref}" is API_TOKEN but names no token placement. Say where the token goes: a storage key, a cookie, or a request header.`,
          { profileRef: profile.ref },
        ),
      );
    }

    const token = await this.resolveToken(profile, executionId);
    if (!token.ok) return token;

    for (const placement of placements) {
      const applied = await this.applyPlacement(placement, token.value, profile, browser);
      if (!applied.ok) return applied;
    }

    // Captured so later runs reuse it: cookies and origin storage are exactly
    // what `storageState` serializes, and a token placed as a header is
    // reapplied from the profile on the next launch.
    const captured = await browser.captureStorageState();
    if (captured.ok) {
      const saved = await this.deps.storageStates.save({
        workspaceRef: profile.workspaceRef,
        profileRef: profile.ref,
        state: captured.value,
        capturedAt: this.deps.clock.nowIso(),
        expiresAt: new Date(this.deps.clock.now() + DEFAULT_STATE_TTL_MS).toISOString(),
      });
      if (!saved.ok) {
        this.deps.logger.warn('Authenticated by token but could not store the session', {
          profileRef: profile.ref,
          errorCode: saved.error.code,
        });
      }
    }

    this.deps.logger.info('Authenticated with a token', {
      profileRef: profile.ref,
      // Where it went, never what it was.
      placements: placements.map((placement) => placement.kind),
    });
    return ok(undefined);
  }

  /**
   * Obtains the token: a stored value, or an exchange with a login endpoint.
   *
   * Nothing here logs the token or the request body. The body *is* the
   * credential for an `apiLogin`, and the response is the token.
   */
  private async resolveToken(
    profile: ExecutionProfile,
    executionId: string,
  ): Promise<Result<string>> {
    const source = profile.tokenSource;

    if (source === undefined) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Profile "${profile.ref}" is API_TOKEN but says where no token comes from. Give it a stored token, or a login endpoint to exchange credentials at.`,
          { profileRef: profile.ref },
        ),
      );
    }

    const secrets = await this.deps.secrets.resolveSecrets(profile, executionId);
    if (!secrets.ok) return secrets;

    if (source.kind === 'static') {
      const secret = secrets.value[source.secretRef];
      if (secret === undefined) {
        return err(
          RunnerErrors.preconditionFailed(
            'authenticated',
            `Profile "${profile.ref}" names token secret "${source.secretRef}" but it resolved to nothing.`,
            { profileRef: profile.ref, secretRef: source.secretRef },
          ),
        );
      }
      return ok(secret.value);
    }

    if (this.deps.http === undefined) {
      return err(
        RunnerErrors.capabilityNotImplemented(
          'An apiLogin token source (this worker has no HTTP client bound)',
        ),
      );
    }

    const body =
      source.bodyTemplate === undefined
        ? undefined
        : fillTemplate(source.bodyTemplate, secrets.value);

    const headers = await this.headerValues(source.headers ?? [], secrets.value, profile);
    if (!headers.ok) return headers;

    const response = await this.deps.http.send({
      url: source.url,
      method: source.method ?? 'POST',
      headers: {
        'content-type': source.contentType ?? 'application/json',
        ...headers.value,
      },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Could not reach the login endpoint for profile "${profile.ref}": ${response.error.message}`,
          { profileRef: profile.ref },
        ),
      );
    }

    if (response.value.status < 200 || response.value.status >= 300) {
      /*
       * A refusal from the login endpoint is a PRECONDITION failure, not a test
       * failure: the application under test has not been shown to misbehave.
       * The status is reported; the body is not, because a login response body
       * routinely echoes the credential back in an error message.
       */
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `The login endpoint for profile "${profile.ref}" answered ${response.value.status}.`,
          { profileRef: profile.ref, status: response.value.status },
        ),
      );
    }

    return extractToken(response.value.body, source.tokenPath, profile.ref);
  }

  /** Writes the token into one place the application will look. */
  private async applyPlacement(
    placement: TokenPlacement,
    token: string,
    profile: ExecutionProfile,
    browser: BrowserPort,
  ): Promise<Result<void>> {
    switch (placement.kind) {
      case 'header': {
        const name = placement.name ?? 'Authorization';
        const prefix = placement.prefix ?? 'Bearer ';
        return browser.setExtraHeaders({ [name]: `${prefix}${token}` });
      }

      case 'cookie': {
        const origin = originOf(placement.domain ?? profile.loginUrl);
        if (origin === undefined) {
          return err(
            RunnerErrors.preconditionFailed(
              'authenticated',
              `Profile "${profile.ref}" places a token in cookie "${placement.name}" but says no domain, and has no loginUrl to take one from.`,
              { profileRef: profile.ref },
            ),
          );
        }

        const cookie: BrowserCookie = {
          name: placement.name,
          value: token,
          ...(placement.domain === undefined ? { url: origin } : { domain: placement.domain }),
          path: placement.path ?? '/',
          ...(placement.httpOnly === undefined ? {} : { httpOnly: placement.httpOnly }),
          ...(placement.secure === undefined ? {} : { secure: placement.secure }),
          ...(placement.sameSite === undefined ? {} : { sameSite: placement.sameSite }),
        };
        return browser.addCookies([cookie]);
      }

      case 'localStorage':
      case 'sessionStorage': {
        const origin = originOf(placement.origin ?? profile.loginUrl);
        if (origin === undefined) {
          return err(
            RunnerErrors.preconditionFailed(
              'authenticated',
              `Profile "${profile.ref}" places a token in ${placement.kind} but names no origin, and has no loginUrl to take one from. Storage is origin-scoped, so it would be written nowhere useful.`,
              { profileRef: profile.ref },
            ),
          );
        }

        /*
         * Many applications store a JSON envelope rather than a bare token —
         * `{"state":{"token":"…"}}` for a Zustand-persisted store, for
         * instance — and a bare string in that slot reads as a corrupt session.
         * The template says which, so the Runner does not have to guess.
         */
        const value =
          placement.jsonTemplate === undefined
            ? token
            : placement.jsonTemplate.replaceAll('{{token}}', jsonEscape(token));

        return browser.seedOriginStorage({
          origin,
          storage: placement.kind,
          entries: { [placement.key]: value },
        });
      }

      default:
        return err(
          RunnerErrors.validationFailed(
            `Unknown token placement on profile "${profile.ref}".`,
          ),
        );
    }
  }

  /**
   * Applies the profile's own headers to the browser.
   *
   * Worth knowing what this cannot do: a context header goes to *every* origin
   * the page reaches, including third parties, because that is how browsers
   * work and Playwright does not filter by origin. A profile putting a
   * credential here is trusting every host the application talks to, so the
   * fact is logged rather than left to be discovered.
   */
  private async applyExtraHeaders(
    profile: ExecutionProfile,
    browser: BrowserPort,
    executionId: string,
  ): Promise<Result<void>> {
    const declared = profile.extraHeaders ?? [];
    if (declared.length === 0) return ok(undefined);

    const secrets = await this.deps.secrets.resolveSecrets(profile, executionId);
    if (!secrets.ok) return secrets;

    const headers = await this.headerValues(declared, secrets.value, profile);
    if (!headers.ok) return headers;

    const applied = await browser.setExtraHeaders(headers.value);
    if (!applied.ok) return applied;

    const sensitive = declared.filter((header) => header.secretRef !== undefined);
    if (sensitive.length > 0) {
      this.deps.logger.warn(
        'A profile sends credential-bearing headers to every origin the page reaches, including third parties.',
        {
          profileRef: profile.ref,
          headers: sensitive.map((header) => header.name),
        },
      );
    }

    return ok(undefined);
  }

  /** Resolves declared headers into literal values. */
  private async headerValues(
    declared: readonly ProfileHeader[],
    secrets: Record<string, ResolvedSecret>,
    profile: ExecutionProfile,
  ): Promise<Result<Record<string, string>>> {
    const headers: Record<string, string> = {};

    for (const header of declared) {
      if (header.secretRef !== undefined) {
        const secret = secrets[header.secretRef];
        if (secret === undefined) {
          return err(
            RunnerErrors.preconditionFailed(
              'authenticated',
              `Header "${header.name}" on profile "${profile.ref}" names secret "${header.secretRef}", which resolved to nothing.`,
              { profileRef: profile.ref, header: header.name },
            ),
          );
        }
        headers[header.name] = secret.value;
        continue;
      }

      if (header.value === undefined) {
        return err(
          RunnerErrors.validationFailed(
            `Header "${header.name}" on profile "${profile.ref}" has neither a value nor a secretRef.`,
          ),
        );
      }
      headers[header.name] = header.value;
    }

    return ok(headers);
  }

  /**
   * Replays a UI login, then stores the session it produced.
   *
   * Field targets are `ElementIntent`s resolved through the ordinary locator
   * engine, so a login form is found the same way any other element is — no
   * hand-written selectors in a profile.
   */
  private async formLogin(
    profile: ExecutionProfile,
    browser: BrowserPort,
    executionId: string,
  ): Promise<Result<void>> {
    const { loginUrl, formFields } = profile;

    if (loginUrl === undefined || loginUrl.length === 0) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Profile "${profile.ref}" is FORM_LOGIN but has no loginUrl.`,
          { profileRef: profile.ref },
        ),
      );
    }
    if (formFields === undefined || Object.keys(formFields).length === 0) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Profile "${profile.ref}" is FORM_LOGIN but names no form fields.`,
          { profileRef: profile.ref },
        ),
      );
    }

    const secrets = await this.deps.secrets.resolveSecrets(profile, executionId);
    if (!secrets.ok) return secrets;

    const navigated = await browser.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    if (!navigated.ok) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Could not open the login page: ${navigated.error.message}`,
          { profileRef: profile.ref, loginUrl },
        ),
      );
    }

    const snapshot = await browser.inspect({ interactableOnly: true });
    if (!snapshot.ok) return snapshot;

    // Fill every named field, then submit. The submit control is whichever
    // field is named `submit`, or the form's own submit button by role.
    for (const [fieldName, intentName] of Object.entries(formFields)) {
      if (fieldName === 'submit') continue;

      const filled = await this.fillField(
        browser,
        snapshot.value,
        fieldName,
        intentName,
        secrets.value,
        profile,
      );
      if (!filled.ok) return filled;
    }

    const submitted = await this.submit(browser, snapshot.value, formFields, profile);
    if (!submitted.ok) return submitted;

    // Capture only after the login has actually taken effect, so a stored
    // session is never one that merely reached the login page.
    const captured = await browser.captureStorageState();
    if (!captured.ok) {
      this.deps.logger.warn('Logged in but could not capture the session', {
        profileRef: profile.ref,
        errorCode: captured.error.code,
      });
      return ok(undefined);
    }

    const saved = await this.deps.storageStates.save({
      workspaceRef: profile.workspaceRef,
      profileRef: profile.ref,
      state: captured.value,
      capturedAt: this.deps.clock.nowIso(),
      expiresAt: new Date(this.deps.clock.now() + DEFAULT_STATE_TTL_MS).toISOString(),
    });
    if (!saved.ok) {
      // A login that worked but could not be cached is still a success; the
      // next run simply logs in again.
      this.deps.logger.warn('Could not store the captured session', {
        profileRef: profile.ref,
        errorCode: saved.error.code,
      });
    }

    this.deps.logger.info('Authenticated through a form login', {
      profileRef: profile.ref,
      fields: Object.keys(formFields).filter((name) => name !== 'submit').length,
    });
    return ok(undefined);
  }

  private async fillField(
    browser: BrowserPort,
    snapshot: PageSnapshot,
    fieldName: string,
    intentName: string,
    secrets: Record<string, ResolvedSecret>,
    profile: ExecutionProfile,
  ): Promise<Result<void>> {
    const secretRef = profile.secretRefs[fieldName];
    const secret = secretRef === undefined ? undefined : secrets[secretRef];

    if (secret === undefined) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Profile "${profile.ref}" names field "${fieldName}" but no secret was resolved for it.`,
          // The missing *key* is safe to report; the value would not be.
          { profileRef: profile.ref, field: fieldName },
        ),
      );
    }

    const resolved = await this.resolve(browser, snapshot, { name: intentName }, true);
    if (!resolved.ok) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Could not find the "${intentName}" field on the login page.`,
          { profileRef: profile.ref, field: fieldName },
        ),
      );
    }

    const action: TestAction = {
      id: `auth_fill_${fieldName}`,
      type: 'fill',
      label: `fill ${fieldName}`,
      value: secret.value,
      preconditions: [],
      continueOnFailure: false,
    };

    const executed = await browser.execute(action, resolved.value, this.authContext(profile));
    if (!executed.ok) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Could not fill the "${intentName}" field.`,
          { profileRef: profile.ref, field: fieldName },
        ),
      );
    }
    return ok(undefined);
  }

  private async submit(
    browser: BrowserPort,
    snapshot: PageSnapshot,
    formFields: Readonly<Record<string, string>>,
    profile: ExecutionProfile,
  ): Promise<Result<void>> {
    const submitIntent: ElementIntent =
      formFields.submit === undefined
        ? { role: 'button' }
        : { name: formFields.submit, role: 'button' };

    const resolved = await this.resolve(browser, snapshot, submitIntent, false);
    if (!resolved.ok) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          'Could not find the submit control on the login page.',
          { profileRef: profile.ref },
        ),
      );
    }

    const action: TestAction = {
      id: 'auth_submit',
      type: 'click',
      label: 'submit the login form',
      preconditions: [],
      continueOnFailure: false,
    };

    const executed = await browser.execute(action, resolved.value, this.authContext(profile));
    if (!executed.ok) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Submitting the login form failed: ${executed.error.message}`,
          { profileRef: profile.ref },
        ),
      );
    }
    return ok(undefined);
  }

  private async resolve(
    browser: BrowserPort,
    snapshot: PageSnapshot,
    intent: ElementIntent,
    requireEditable: boolean,
  ): Promise<Result<ScopedSelector>> {
    const resolved = await this.deps.resolver.resolve({
      intent,
      snapshot,
      browser,
      requireInteractable: true,
      requireEditable,
    });
    if (!resolved.ok) return resolved;
    return ok({ selector: resolved.value.locator });
  }

  /**
   * A minimal context for the login's own actions.
   *
   * The login is not a step of the test, so it carries no plan and contributes
   * nothing to the timeline — `baseUrl` is deliberately absent because the
   * profile's `loginUrl` is already absolute.
   */
  private authContext(profile: ExecutionProfile): Parameters<BrowserPort['execute']>[2] {
    return {
      executionId: `auth_${profile.ref}`,
      browserSessionId: 'auth',
      applicationState: [],
      startedAt: this.deps.clock.nowIso(),
      plan: {
        executionId: `auth_${profile.ref}`,
        workspaceRef: profile.workspaceRef,
        mode: 'AUTO',
        testId: `auth_${profile.ref}`,
        testName: `Authenticate as ${profile.displayName}`,
        actions: [],
        metadata: {},
        options: {
          headless: true,
          viewport: { width: 1280, height: 720 },
          defaultTimeoutMs: 15_000,
          stopOnFailure: true,
          enableRegistryLearning: false,
          enableSelfHealing: false,
        },
      },
    } as Parameters<BrowserPort['execute']>[2];
  }
}

/**
 * Substitutes `{{secretRef}}` placeholders in a login request body.
 *
 * A template rather than named fields because login payloads differ wildly —
 * nested objects, a tenant alongside the credentials, extra constants — and a
 * fixed shape would fit almost none of them.
 *
 * Values are JSON-escaped, so a password containing a quote or a backslash
 * produces a valid body instead of a parse error the endpoint reports as bad
 * credentials.
 */
function fillTemplate(template: string, secrets: Record<string, ResolvedSecret>): string {
  return template.replaceAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (whole, ref: string) => {
    const secret = secrets[ref];
    // An unknown placeholder is left as written: blanking it would send an
    // empty credential, and the endpoint would answer "wrong password" for
    // what is really a typo in the template.
    return secret === undefined ? whole : jsonEscape(secret.value);
  });
}

/**
 * Reads the token out of a login response.
 *
 * The path is required and never inferred. Picking the first string that looks
 * like a JWT would choose a refresh token about as often as an access token,
 * and the resulting failure — authenticated for a few seconds, then not —
 * is one of the harder ones to attribute.
 */
function extractToken(body: string, path: string, profileRef: string): Result<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return err(
      RunnerErrors.preconditionFailed(
        'authenticated',
        `The login endpoint for profile "${profileRef}" did not answer with JSON.`,
        { profileRef },
      ),
    );
  }

  let current: unknown = parsed;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      current = undefined;
      break;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current === 'string' && current.length > 0) return ok(current);
  if (typeof current === 'number') return ok(String(current));

  /*
   * The path is named in the error; the body is not.
   *
   * Naming the path is what makes this fixable — "data.access_token was not
   * there" points straight at the profile — while a body dump would put the
   * credential the caller just sent, and often the token itself, into a log.
   */
  return err(
    RunnerErrors.preconditionFailed(
      'authenticated',
      `The login endpoint for profile "${profileRef}" answered successfully, but "${path}" held no token.`,
      { profileRef, tokenPath: path },
    ),
  );
}

/**
 * The scheme-and-host of a URL, or of a bare domain.
 *
 * Storage and cookies are both origin-scoped, so a placement that cannot be
 * given an origin is written somewhere the application will never read.
 */
function originOf(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;

  try {
    return new URL(raw).origin;
  } catch {
    // A bare domain such as `app.example.com`, or a leading-dot cookie domain.
    const host = raw.replace(/^\./, '').trim();
    if (host.length === 0 || host.includes('/')) return undefined;
    return `https://${host}`;
  }
}

/** Escapes a value for embedding inside a JSON string literal. */
function jsonEscape(value: string): string {
  // JSON.stringify quotes the string; the slice drops the surrounding quotes,
  // leaving exactly the escaped contents a template placeholder needs.
  return JSON.stringify(value).slice(1, -1);
}
