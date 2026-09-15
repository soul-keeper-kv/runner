import type { StorageStateStorePort } from '@runner/application';
import type {
  AuthLoginPayload,
  AuthStatusResult,
  LiveCommandType,
  RawLiveCommand,
} from '@runner/live-protocol';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';
import {
  payloadOf,
  type LiveCapability,
  type LiveSessionContext,
} from '../capability-registry.js';
import type { AuthService } from '../../modules/auth/auth-service.js';

/**
 * Authenticating a live session (blueprint sections 9, 26 and 50).
 *
 * A live session exists to debug the page that actually caused a problem, and
 * for most applications that page is behind a login. Starting a session with an
 * `authProfileRef` covers the common case — the runtime applies a stored
 * session at launch — but two situations need a command:
 *
 *  - **Nothing has been stored yet.** A profile's first ever login has to
 *    happen somewhere, and doing it here means a user can reach an internal
 *    page without an execution having run first.
 *  - **The application invalidated the session.** A live view that has been
 *    open for an hour can be logged out from under the user. `force` replays
 *    the login into the *same* browser, which is the whole point: a session
 *    that had to be restarted would lose the state being investigated.
 *
 * Three rules this capability does not bend:
 *
 *  - **It accepts a profile reference, never a credential.** The command
 *    arrives over a WebSocket from a browser tab; a payload carrying a password
 *    would put it in a client, in a socket frame and in logs.
 *  - **A failed login is `PRECONDITION_FAILED`, not a test failure.** Nothing
 *    here has shown the application to be wrong.
 *  - **`authenticatedAs` is set from what the Runner did**, never from reading
 *    the page. "There is a Sign out link, so we must be logged in" is how a
 *    whole suite runs against a login screen.
 */
export class AuthCapability implements LiveCapability<AuthStatusResult> {
  readonly type = 'auth' as const;
  readonly handles: readonly LiveCommandType[] = ['auth.login', 'auth.status', 'auth.logout'];

  constructor(
    private readonly auth: AuthService,
    private readonly storageStates: StorageStateStorePort,
  ) {}

  async execute(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<AuthStatusResult>> {
    switch (command.type as LiveCommandType) {
      case 'auth.login':
        return this.login(command, context);
      case 'auth.status':
        return this.status(context);
      case 'auth.logout':
        return this.logout(context);
      default:
        return err(RunnerErrors.liveCommandUnsupported(command.type));
    }
  }

  private async login(
    command: RawLiveCommand,
    context: LiveSessionContext,
  ): Promise<Result<AuthStatusResult>> {
    const payload = payloadOf<AuthLoginPayload>(command);
    if (!payload.ok) return payload;

    const { profileRef, force = false } = payload.value;
    if (typeof profileRef !== 'string' || profileRef.trim().length === 0) {
      return err(RunnerErrors.validationFailed('auth.login requires a profileRef.'));
    }

    const { workspaceRef } = context.session;

    // A stored session already in this browser means there is nothing to do —
    // and replaying a login would navigate away from the page the user is
    // looking at, which is the one thing a live session must not do casually.
    if (!force && context.session.authenticatedAs === profileRef) {
      context.logger.debug('Live session is already authenticated', { profileRef });
      return this.describe(workspaceRef, profileRef, profileRef, true);
    }

    context.logger.info('Authenticating a live session', { profileRef, force });

    const authenticated = await this.auth.authenticate(
      workspaceRef,
      profileRef,
      context.browser,
      // The login is not a step of any test, so it is attributed to the live
      // session rather than to an execution id it would otherwise invent.
      `live_${context.session.id}`,
    );
    if (!authenticated.ok) return authenticated;

    // Only now, having actually logged in. The runtime persists this with the
    // revision it publishes for this command.
    context.patchSession?.({ authenticatedAs: profileRef });

    return this.describe(workspaceRef, profileRef, profileRef, false);
  }

  /**
   * Reports the session's authentication without touching the page.
   *
   * Deliberately cheap and side-effect free: a client polls this to render
   * "signed in as MANAGER", and a status check that navigated or re-logged-in
   * would make the indicator itself change the session.
   */
  private async status(context: LiveSessionContext): Promise<Result<AuthStatusResult>> {
    const { workspaceRef, authProfileRef, authenticatedAs } = context.session;

    const profileRef = authenticatedAs ?? authProfileRef;
    if (profileRef === undefined) {
      return ok({ fromStoredSession: false });
    }

    return this.describe(workspaceRef, profileRef, authenticatedAs, authenticatedAs !== undefined);
  }

  /**
   * Drops the stored session for the profile, forcing the next login to be real.
   *
   * It does **not** click a Sign out control in the page: that would be an
   * action on the application under test, driven by a session whose job is to
   * observe it. Invalidating the Runner's own cache is the honest scope, and it
   * is what a user wants when a stored session has gone stale.
   */
  private async logout(context: LiveSessionContext): Promise<Result<AuthStatusResult>> {
    const { workspaceRef, authenticatedAs, authProfileRef } = context.session;
    const profileRef = authenticatedAs ?? authProfileRef;

    if (profileRef === undefined) {
      return ok({ fromStoredSession: false });
    }

    const invalidated = await this.storageStates.invalidate(workspaceRef, profileRef);
    if (!invalidated.ok) return invalidated;

    context.patchSession?.({ authenticatedAs: undefined });
    context.logger.info('Stored session invalidated for a live session', { profileRef });

    return ok({ fromStoredSession: false, profileRef });
  }

  /** Reads back the stored session so a client can show when it expires. */
  private async describe(
    workspaceRef: string,
    profileRef: string,
    authenticatedAs: string | undefined,
    fromStoredSession: boolean,
  ): Promise<Result<AuthStatusResult>> {
    const stored = await this.storageStates.get(workspaceRef, profileRef);
    if (!stored.ok) return stored;

    return ok({
      ...(authenticatedAs === undefined ? {} : { authenticatedAs }),
      fromStoredSession,
      profileRef,
      ...(stored.value?.capturedAt === undefined ? {} : { capturedAt: stored.value.capturedAt }),
      ...(stored.value?.expiresAt === undefined ? {} : { expiresAt: stored.value.expiresAt }),
    });
  }
}
