import type { BrowserManagerPort, StorageStateStorePort } from '@runner/application';
import type { ExecutionContext, Precondition } from '@runner/domain';
import { RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';
import type { StateHandler } from '../state/precondition-engine.js';
import type { AuthService } from './auth-service.js';

/**
 * Satisfies an `authenticated` precondition (blueprint sections 19 and 20).
 *
 * The distinction this handler exists to preserve: **a login that cannot be
 * performed is a PRECONDITION failure, never a test failure.** If the Runner
 * cannot authenticate, the application under test has not been shown to
 * misbehave, and a report that blames it teaches a team to distrust its
 * results. Every error path here carries `PRECONDITION_FAILED` or
 * `AUTH_FAILED`, both of which map to `PRECONDITION_FAILURE`.
 *
 * It is registered on `PreconditionEngine`, which re-checks `isSatisfied` after
 * `prepare` — so a login that appeared to succeed but left the browser
 * unauthenticated fails loudly rather than letting the first real step run
 * against a login page.
 */
export class AuthenticatedStateHandler implements StateHandler {
  readonly type = 'authenticated';

  constructor(
    private readonly auth: AuthService,
    private readonly browsers: BrowserManagerPort,
    private readonly storageStates: StorageStateStorePort,
    private readonly logger: Logger,
  ) {}

  canHandle(precondition: Precondition): boolean {
    return precondition.type === 'authenticated';
  }

  /**
   * Is this browser authenticated as the named profile?
   *
   * Two signals, neither of which is page content. Guessing from the page —
   * "there is a Sign out link, so we must be logged in" — concludes a run is
   * authenticated because the word appeared in a cookie banner.
   *
   *  1. `authenticatedAs`, set when the launch restored a stored session.
   *  2. A stored session existing for the profile, which is what a completed
   *     login produces.
   *
   * The second matters because `ExecutionContext` is immutable and the engine
   * re-checks with the *same* context it passed to `prepare`: a handler that
   * only read `authenticatedAs` could never report its own login as successful,
   * and every authenticated run would fail with "prepared but still not
   * satisfied".
   */
  async isSatisfied(
    precondition: Precondition,
    context: ExecutionContext,
  ): Promise<Result<boolean>> {
    const profileRef = precondition.profile;
    if (profileRef === undefined) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          'An authenticated precondition must name a profile.',
        ),
      );
    }

    if (context.authenticatedAs === profileRef) return ok(true);

    const stored = await this.storageStates.get(context.plan.workspaceRef, profileRef);
    if (!stored.ok) return stored;

    return ok(stored.value !== undefined);
  }

  async prepare(
    precondition: Precondition,
    context: ExecutionContext,
  ): Promise<Result<void>> {
    const profileRef = precondition.profile;
    if (profileRef === undefined) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          'An authenticated precondition must name a profile.',
        ),
      );
    }

    // The context carries a session id, not a browser: two executions must
    // never be able to reach each other's browser through a shared reference.
    const browser = this.browsers.get(context.browserSessionId);
    if (browser === undefined) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `Browser session "${context.browserSessionId}" is no longer available.`,
          { profileRef },
        ),
      );
    }

    this.logger.info('Authenticating for a precondition', {
      runId: context.executionId,
      profileRef,
    });

    const authenticated = await this.auth.authenticate(
      context.plan.workspaceRef,
      profileRef,
      browser,
      context.executionId,
    );
    if (!authenticated.ok) return authenticated;

    return ok(undefined);
  }
}
