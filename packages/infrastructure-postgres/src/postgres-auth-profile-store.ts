import type {
  AuthProfileStorePort,
  AuthProfileView,
  ExecutionProfile,
  ProfileHeader,
  SaveAuthProfileInput,
  TokenPlacement,
  TokenSource,
} from '@runner/application';
import {
  RunnerErrors,
  err,
  ok,
  type Clock,
  type Logger,
  type Result,
  type SecretBox,
} from '@runner/shared';
import type { PostgresClient } from './postgres-client.js';

/**
 * Auth profiles in Postgres, with credentials sealed (migration 0002).
 *
 * The split is the whole design. `execution_profiles` holds what a user edits
 * and a client displays; `profile_secrets` holds credential values as
 * AES-256-GCM ciphertext under a key that lives in the environment. A dump of
 * this database reveals a login URL and some field names, and nothing else.
 *
 * Three rules this adapter does not bend:
 *
 *  - **A sealed value never leaves.** Every read path returns
 *    `secretsPresent` — field names — and only `resolveForExecution` decrypts.
 *  - **A save never silently clears a credential.** Omitted secrets are left
 *    alone, so editing a login URL cannot log a suite out. An empty string is
 *    the explicit way to remove one.
 *  - **Writing a profile is one transaction.** A profile without its secrets,
 *    or secrets orphaned from their profile, would both surface later as a
 *    login failure blamed on the application under test.
 */
export class PostgresAuthProfileStore implements AuthProfileStorePort {
  constructor(
    private readonly sql: PostgresClient,
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async list(workspaceRef: string): Promise<Result<AuthProfileView[]>> {
    try {
      const rows = await this.sql<ProfileRow[]>`
        SELECT p.*,
               COALESCE(
                 (SELECT json_agg(s.secret_key ORDER BY s.secret_key)
                  FROM profile_secrets s WHERE s.profile_id = p.id),
                 '[]'::json
               ) AS secret_keys,
               COALESCE(
                 (SELECT json_object_agg(r.secret_key, r.secret_ref)
                  FROM secret_references r WHERE r.profile_id = p.id),
                 '{}'::json
               ) AS secret_refs
        FROM execution_profiles p
        WHERE p.workspace_ref = ${workspaceRef}
        ORDER BY p.profile_ref
      `;

      return ok(rows.map(toView));
    } catch (cause) {
      return err(RunnerErrors.internal('Could not list auth profiles.', cause));
    }
  }

  async get(workspaceRef: string, ref: string): Promise<Result<AuthProfileView>> {
    const found = await this.findRow(workspaceRef, ref);
    if (!found.ok) return found;

    if (found.value === undefined) {
      return err(
        RunnerErrors.registryEntityNotFound('auth profile', `${workspaceRef}/${ref}`),
      );
    }
    return ok(toView(found.value));
  }

  /**
   * Creates or replaces a profile.
   *
   * `ON CONFLICT` on `(workspace_ref, profile_ref)` rather than a read-then-write:
   * two users saving the same profile at once would otherwise both see "not
   * present" and one would lose its write.
   */
  async save(input: SaveAuthProfileInput): Promise<Result<AuthProfileView>> {
    const validated = validate(input);
    if (!validated.ok) return validated;

    /*
     * Placement and source travel together, as one column.
     *
     * Undefined rather than an empty object when neither is given, so a
     * FORM_LOGIN profile does not carry an empty token configuration that a
     * later reader could mistake for a configured one.
     */
    const tokenConfig: TokenConfigRow | undefined =
      input.tokenPlacements === undefined && input.tokenSource === undefined
        ? undefined
        : {
            ...(input.tokenPlacements === undefined
              ? {}
              : { placements: input.tokenPlacements }),
            ...(input.tokenSource === undefined ? {} : { source: input.tokenSource }),
          };

    // Sealed before the transaction opens: a key problem must not leave a
    // half-written profile behind.
    const sealed: { key: string; ciphertext: string; iv: string; tag: string }[] = [];
    const removed: string[] = [];

    for (const [key, value] of Object.entries(input.secrets ?? {})) {
      if (value.length === 0) {
        // The explicit way to remove a credential, as opposed to omitting it.
        removed.push(key);
        continue;
      }

      const box = this.secrets.seal(value);
      if (!box.ok) return box;
      sealed.push({
        key,
        ciphertext: box.value.ciphertext,
        iv: box.value.iv,
        tag: box.value.tag,
      });
    }

    try {
      await this.sql.begin(async (tx) => {
        await tx`
          INSERT INTO external_workspaces (workspace_ref)
          VALUES (${input.workspaceRef})
          ON CONFLICT (workspace_ref) DO NOTHING
        `;

        const [profile] = await tx<{ id: string }[]>`
          INSERT INTO execution_profiles
            (workspace_ref, profile_ref, display_name, strategy, login_url, form_fields,
             token_config, extra_headers, updated_at)
          VALUES (
            ${input.workspaceRef},
            ${input.ref},
            ${input.displayName},
            ${input.strategy},
            ${input.loginUrl ?? null},
            ${tx.json(input.formFields as Record<string, string>)},
            ${tokenConfig === undefined ? null : tx.json(tokenConfig as never)},
            ${tx.json((input.extraHeaders ?? []) as never)},
            ${this.clock.nowIso()}
          )
          ON CONFLICT (workspace_ref, profile_ref) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            strategy     = EXCLUDED.strategy,
            login_url     = EXCLUDED.login_url,
            form_fields   = EXCLUDED.form_fields,
            token_config  = EXCLUDED.token_config,
            extra_headers = EXCLUDED.extra_headers,
            updated_at    = EXCLUDED.updated_at
          RETURNING id
        `;

        if (profile === undefined) {
          throw new Error('The profile upsert returned no row.');
        }

        for (const secret of sealed) {
          await tx`
            INSERT INTO profile_secrets
              (profile_id, secret_key, ciphertext, iv, auth_tag, algorithm, updated_at)
            VALUES (
              ${profile.id}, ${secret.key}, ${secret.ciphertext}, ${secret.iv},
              ${secret.tag}, 'aes-256-gcm', ${this.clock.nowIso()}
            )
            ON CONFLICT (profile_id, secret_key) DO UPDATE SET
              ciphertext = EXCLUDED.ciphertext,
              iv         = EXCLUDED.iv,
              auth_tag   = EXCLUDED.auth_tag,
              algorithm  = EXCLUDED.algorithm,
              updated_at = EXCLUDED.updated_at
          `;
        }

        for (const key of removed) {
          await tx`
            DELETE FROM profile_secrets
            WHERE profile_id = ${profile.id} AND secret_key = ${key}
          `;
        }

        // Replaced wholesale: an external reference that is no longer named has
        // been deliberately dropped, and leaving it would keep resolving a
        // credential the user removed.
        await tx`DELETE FROM secret_references WHERE profile_id = ${profile.id}`;

        for (const [key, value] of Object.entries(input.secretRefs ?? {})) {
          await tx`
            INSERT INTO secret_references (profile_id, secret_key, secret_ref)
            VALUES (${profile.id}, ${key}, ${value})
          `;
        }
      });
    } catch (cause) {
      return err(RunnerErrors.internal('Could not save the auth profile.', cause));
    }

    this.logger.info('Auth profile saved', {
      workspaceRef: input.workspaceRef,
      profileRef: input.ref,
      // Field names only. A value must never reach a log (blueprint 50).
      secretsSet: sealed.map((secret) => secret.key),
      secretsRemoved: removed,
    });

    return this.get(input.workspaceRef, input.ref);
  }

  async delete(workspaceRef: string, ref: string): Promise<Result<void>> {
    try {
      // profile_secrets and secret_references cascade, so a deleted profile
      // cannot leave a sealed credential behind with nothing pointing at it.
      const rows = await this.sql<{ id: string }[]>`
        DELETE FROM execution_profiles
        WHERE workspace_ref = ${workspaceRef} AND profile_ref = ${ref}
        RETURNING id
      `;

      if (rows.length === 0) {
        return err(
          RunnerErrors.registryEntityNotFound('auth profile', `${workspaceRef}/${ref}`),
        );
      }

      this.logger.info('Auth profile deleted', { workspaceRef, profileRef: ref });
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not delete the auth profile.', cause));
    }
  }

  /**
   * The one method that decrypts.
   *
   * Kept separate from `get` so a route that lists profiles cannot reach a
   * credential by accident, and so an audit has exactly one call site to read.
   */
  async resolveForExecution(
    workspaceRef: string,
    ref: string,
  ): Promise<Result<{ profile: ExecutionProfile; secrets: Record<string, string> }>> {
    const found = await this.findRow(workspaceRef, ref);
    if (!found.ok) return found;

    if (found.value === undefined) {
      return err(
        RunnerErrors.preconditionFailed(
          'authenticated',
          `No auth profile "${ref}" is configured for this workspace.`,
          { profileRef: ref, workspaceRef },
        ),
      );
    }

    const row = found.value;

    let sealedRows: SecretRow[];
    try {
      sealedRows = await this.sql<SecretRow[]>`
        SELECT secret_key, ciphertext, iv, auth_tag, algorithm
        FROM profile_secrets
        WHERE profile_id = ${row.id}
      `;
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the profile credentials.', cause));
    }

    const secrets: Record<string, string> = {};
    for (const sealed of sealedRows) {
      const opened = this.secrets.open({
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        tag: sealed.auth_tag,
        algorithm: sealed.algorithm,
      });

      if (!opened.ok) {
        // Naming the field is safe and is what makes this diagnosable; the
        // value, obviously, is not.
        return err(
          RunnerErrors.preconditionFailed(
            'authenticated',
            `Credential "${sealed.secret_key}" for profile "${ref}" could not be decrypted. Is RUNNER_SECRET_KEY the key it was saved with?`,
            { profileRef: ref, field: sealed.secret_key },
          ),
        );
      }
      secrets[sealed.secret_key] = opened.value;
    }

    const view = toView(row);

    /*
     * The profile's `secretRefs` are what `AuthService` looks up, and they must
     * name a key that exists in `secrets`. An external reference keeps its
     * environment-variable name so the env provider resolves it; a stored
     * credential is named by its own field, because that is the key this method
     * just filled in.
     */
    const secretRefs: Record<string, string> = { ...view.secretRefs };
    for (const key of Object.keys(secrets)) {
      if (secretRefs[key] === undefined) secretRefs[key] = key;
    }

    return ok({
      profile: {
        ref: view.ref,
        workspaceRef: view.workspaceRef,
        displayName: view.displayName,
        strategy: view.strategy,
        secretRefs,
        ...(view.loginUrl === undefined ? {} : { loginUrl: view.loginUrl }),
        formFields: view.formFields,
        // Without these a stored API_TOKEN profile reaches the worker with no
        // placement and is refused as unconfigured — a baffling way to fail for
        // a profile the user filled in completely.
        ...(view.tokenPlacements === undefined
          ? {}
          : { tokenPlacements: view.tokenPlacements }),
        ...(view.tokenSource === undefined ? {} : { tokenSource: view.tokenSource }),
        ...(view.extraHeaders === undefined || view.extraHeaders.length === 0
          ? {}
          : { extraHeaders: view.extraHeaders }),
      },
      secrets,
    });
  }

  private async findRow(
    workspaceRef: string,
    ref: string,
  ): Promise<Result<ProfileRow | undefined>> {
    try {
      const rows = await this.sql<ProfileRow[]>`
        SELECT p.*,
               COALESCE(
                 (SELECT json_agg(s.secret_key ORDER BY s.secret_key)
                  FROM profile_secrets s WHERE s.profile_id = p.id),
                 '[]'::json
               ) AS secret_keys,
               COALESCE(
                 (SELECT json_object_agg(r.secret_key, r.secret_ref)
                  FROM secret_references r WHERE r.profile_id = p.id),
                 '{}'::json
               ) AS secret_refs
        FROM execution_profiles p
        WHERE p.workspace_ref = ${workspaceRef} AND p.profile_ref = ${ref}
      `;
      return ok(rows[0]);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the auth profile.', cause));
    }
  }
}

interface ProfileRow {
  readonly id: string;
  readonly workspace_ref: string;
  readonly profile_ref: string;
  readonly display_name: string;
  readonly strategy: ExecutionProfile['strategy'];
  readonly login_url: string | null;
  readonly form_fields: Record<string, string>;
  readonly token_config: TokenConfigRow | null;
  readonly extra_headers: ProfileHeader[];
  readonly secret_keys: string[];
  readonly secret_refs: Record<string, string>;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * How token configuration is stored.
 *
 * One JSONB column holds both halves, because they are meaningless apart: a
 * placement with no source has nothing to place, and a source with no placement
 * has nowhere to put what it fetched.
 */
interface TokenConfigRow {
  readonly placements?: readonly TokenPlacement[];
  readonly source?: TokenSource;
}

interface SecretRow {
  readonly secret_key: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly auth_tag: string;
  readonly algorithm: 'aes-256-gcm';
}

function toView(row: ProfileRow): AuthProfileView {
  return {
    ref: row.profile_ref,
    workspaceRef: row.workspace_ref,
    displayName: row.display_name,
    strategy: row.strategy,
    ...(row.login_url === null ? {} : { loginUrl: row.login_url }),
    formFields: row.form_fields,
    secretsPresent: row.secret_keys,
    secretRefs: row.secret_refs,
    // Safe to read back: a placement names a storage key, a cookie or a
    // header, and a token source names the secret holding the token rather
    // than the token itself.
    ...(row.token_config?.placements === undefined
      ? {}
      : { tokenPlacements: row.token_config.placements }),
    ...(row.token_config?.source === undefined
      ? {}
      : { tokenSource: row.token_config.source }),
    extraHeaders: row.extra_headers ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Refuses a profile that cannot possibly log in.
 *
 * Checked here rather than only at the route, because a profile stored broken
 * fails much later as a precondition failure on someone else's test run.
 */
function validate(input: SaveAuthProfileInput): Result<void> {
  if (input.ref.trim().length === 0) {
    return err(RunnerErrors.validationFailed('An auth profile needs a ref.'));
  }
  if (input.workspaceRef.trim().length === 0) {
    return err(RunnerErrors.validationFailed('An auth profile needs a workspaceRef.'));
  }

  if (input.strategy === 'FORM_LOGIN') {
    if (input.loginUrl === undefined || input.loginUrl.trim().length === 0) {
      return err(
        RunnerErrors.validationFailed('A FORM_LOGIN profile needs a loginUrl.', {
          profileRef: input.ref,
        }),
      );
    }
    if (Object.keys(input.formFields).length === 0) {
      return err(
        RunnerErrors.validationFailed(
          'A FORM_LOGIN profile must name its form fields, e.g. {"username":"Email","password":"Password","submit":"Log in"}.',
          { profileRef: input.ref },
        ),
      );
    }
  }

  if (input.strategy === 'API_TOKEN') {
    /*
     * Both halves are required, for the same reason FORM_LOGIN needs a URL and
     * fields: a profile stored half-configured fails much later, as a
     * precondition failure on someone else's run, and the message there cannot
     * say what the author forgot.
     */
    if (input.tokenSource === undefined) {
      return err(
        RunnerErrors.validationFailed(
          'An API_TOKEN profile needs a tokenSource: a stored token, or a login endpoint to exchange credentials at.',
          { profileRef: input.ref },
        ),
      );
    }
    if (input.tokenPlacements === undefined || input.tokenPlacements.length === 0) {
      return err(
        RunnerErrors.validationFailed(
          'An API_TOKEN profile needs at least one tokenPlacement, saying where the token goes: a storage key, a cookie, or a request header.',
          { profileRef: input.ref },
        ),
      );
    }
  }

  return ok(undefined);
}
