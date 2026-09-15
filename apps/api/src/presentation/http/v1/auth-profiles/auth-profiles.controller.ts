import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import type { AuthProfileView } from '@runner/application';
import { RunnerErrors, unwrapOrThrow } from '@runner/shared';
import type { ApiContainer } from '../../../../infrastructure/container.js';
import { CONTAINER } from '../../../../infrastructure/container.token.js';

/**
 * Managing auth profiles over HTTP.
 *
 * This route exists because the alternative was worse in practice: a profile
 * lived only in `RUNNER_AUTH_PROFILES`, so pointing the Runner at another
 * application meant editing an environment variable and restarting a worker,
 * and a user had no way to discover which profiles existed — they typed a name
 * and found out from a failed login.
 *
 * It relaxes blueprint section 50 deliberately and narrowly:
 *
 *  - A credential goes **in** through `PUT` and never comes back out. Reads
 *    report `secretsPresent` — field names — so a client can render
 *    "password: set" without the value leaving the Runner.
 *  - Values are sealed with AES-256-GCM under `RUNNER_SECRET_KEY`, which lives
 *    in the environment and never in the database.
 *  - With no key configured the routes answer `501`, not a stored plaintext. A
 *    deployment that forgot the key must not silently become one that keeps
 *    credentials readable.
 *
 * `secretRefs` remains available on the same profile, so a deployment that
 * keeps its credentials in a vault can name the environment variables instead
 * and store nothing here at all.
 */

interface SaveAuthProfileBody {
  readonly displayName?: string;
  readonly strategy?: AuthProfileView['strategy'];
  readonly loginUrl?: string;
  readonly formFields?: Record<string, string>;
  readonly secretRefs?: Record<string, string>;
  /**
   * Credential values, by form field name.
   *
   * Omitted fields keep the value they already had, so editing a login URL
   * cannot log a suite out. An empty string removes one.
   */
  readonly secrets?: Record<string, string>;
}

@Controller('api/v1/auth/profiles')
export class AuthProfilesController {
  constructor(@Inject(CONTAINER) private readonly container: ApiContainer) {}

  @Get()
  async list(@Query('workspaceRef') workspaceRef?: string): Promise<{
    profiles: readonly AuthProfileView[];
  }> {
    const scope = requireWorkspace(workspaceRef);
    const store = this.requireStore();

    const profiles = unwrapOrThrow(await store.list(scope));
    return { profiles };
  }

  @Get(':profileRef')
  async get(
    @Param('profileRef') profileRef: string,
    @Query('workspaceRef') workspaceRef?: string,
  ): Promise<AuthProfileView> {
    const scope = requireWorkspace(workspaceRef);
    return unwrapOrThrow(await this.requireStore().get(scope, profileRef));
  }

  /**
   * Creates or replaces a profile.
   *
   * `PUT` rather than `POST` because the caller names the resource: a profile
   * ref is chosen by the user and is what Test IR and a live session reference,
   * so the same request must be safe to repeat.
   */
  @Put(':profileRef')
  async save(
    @Param('profileRef') profileRef: string,
    @Body() body: SaveAuthProfileBody,
    @Query('workspaceRef') workspaceRef?: string,
  ): Promise<AuthProfileView> {
    const scope = requireWorkspace(workspaceRef);
    const store = this.requireStore();

    if (body?.strategy === undefined) {
      throw RunnerErrors.validationFailed(
        'strategy is required: FORM_LOGIN, API_TOKEN, COOKIE, STORAGE_STATE, OAUTH or SSO.',
      );
    }

    return unwrapOrThrow(
      await store.save({
        ref: profileRef,
        workspaceRef: scope,
        displayName: body.displayName ?? profileRef,
        strategy: body.strategy,
        formFields: body.formFields ?? {},
        ...(body.loginUrl === undefined ? {} : { loginUrl: body.loginUrl }),
        ...(body.secretRefs === undefined ? {} : { secretRefs: body.secretRefs }),
        ...(body.secrets === undefined ? {} : { secrets: body.secrets }),
      }),
    );
  }

  @Delete(':profileRef')
  @HttpCode(204)
  async delete(
    @Param('profileRef') profileRef: string,
    @Query('workspaceRef') workspaceRef?: string,
  ): Promise<void> {
    const scope = requireWorkspace(workspaceRef);
    unwrapOrThrow(await this.requireStore().delete(scope, profileRef));
  }

  /**
   * The store, or a precise refusal.
   *
   * Two separate reasons it can be absent, and a caller needs to tell them
   * apart: no database at all, or a database but no encryption key.
   */
  private requireStore() {
    const store = this.container.authProfileStore;

    if (store === undefined) {
      throw RunnerErrors.capabilityNotImplemented(
        this.container.config.databaseUrl === ''
          ? 'Managed auth profiles (requires DATABASE_URL)'
          : 'Managed auth profiles (requires RUNNER_SECRET_KEY, at least 16 characters, to seal stored credentials)',
      );
    }
    return store;
  }
}

/**
 * Requires an explicit workspace.
 *
 * Defaulting it would let one tenant list another's profiles — including their
 * login URLs and which credentials are set.
 */
function requireWorkspace(workspaceRef: string | undefined): string {
  if (workspaceRef === undefined || workspaceRef.trim().length === 0) {
    throw RunnerErrors.validationFailed('workspaceRef is required.');
  }
  return workspaceRef;
}
