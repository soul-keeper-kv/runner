import type {
  BrowserPort,
  ExecutionProfile,
  ResolvedSecret,
  SecretProviderPort,
  StorageStateStorePort,
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

    switch (profile.value.strategy) {
      case 'FORM_LOGIN':
        return this.formLogin(profile.value, browser, executionId);

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
            `Authentication strategy ${profile.value.strategy} (Phase 5 implements FORM_LOGIN and STORAGE_STATE)`,
          ),
        );
    }
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
