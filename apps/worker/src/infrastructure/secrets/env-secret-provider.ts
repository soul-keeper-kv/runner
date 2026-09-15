import type {
  ExecutionProfile,
  ResolvedSecret,
  SecretProviderPort,
} from '@runner/application';
import { RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';

/**
 * A SecretProviderPort backed by environment variables and a JSON profile map.
 *
 * This is the local-development adapter, and it is deliberately the only one:
 * a real deployment binds a Vault, AWS Secrets Manager or Azure Key Vault
 * adapter in the composition root, and nothing above this port changes.
 *
 * Profiles are declared in `RUNNER_AUTH_PROFILES` as JSON:
 *
 *   [{
 *     "ref": "MANAGER",
 *     "workspaceRef": "workspace_demo",
 *     "displayName": "Store manager",
 *     "strategy": "FORM_LOGIN",
 *     "loginUrl": "https://app.local/login",
 *     "formFields": { "username": "Email", "password": "Password", "submit": "Login" },
 *     "secretRefs": { "username": "MANAGER_USER", "password": "MANAGER_PASS" }
 *   }]
 *
 * `secretRefs` maps a form field to an **environment variable name**, never to a
 * value. That indirection is the whole point: the profile is safe to commit, log
 * and return over the API, while the credential only ever exists in the
 * process environment of the worker that needs it.
 */

const PROFILES_ENV = 'RUNNER_AUTH_PROFILES';

export class EnvSecretProvider implements SecretProviderPort {
  private readonly profiles: Map<string, ExecutionProfile>;

  constructor(
    private readonly logger: Logger,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.env = env;
    this.profiles = parseProfiles(env[PROFILES_ENV], logger);

    if (this.profiles.size > 0) {
      this.logger.info('Auth profiles loaded', {
        profiles: [...this.profiles.values()].map((profile) => profile.ref).join(', '),
      });
    }
  }

  private readonly env: NodeJS.ProcessEnv;

  getProfile(workspaceRef: string, profileRef: string): Promise<Result<ExecutionProfile>> {
    const profile = this.profiles.get(keyOf(workspaceRef, profileRef));

    if (profile === undefined) {
      return Promise.resolve(
        err(
          RunnerErrors.preconditionFailed(
            'authenticated',
            `No auth profile "${profileRef}" is configured for this workspace. Declare it in ${PROFILES_ENV}.`,
            { profileRef, workspaceRef },
          ),
        ),
      );
    }
    return Promise.resolve(ok(profile));
  }

  /**
   * Resolves only the secrets this profile names, for one execution.
   *
   * A missing variable fails loudly rather than filling an empty string: an
   * empty password produces a login failure that looks like wrong credentials,
   * which is a far harder thing to diagnose than a missing configuration value.
   */
  resolveSecrets(
    profile: ExecutionProfile,
    executionId: string,
  ): Promise<Result<Record<string, ResolvedSecret>>> {
    const resolved: Record<string, ResolvedSecret> = {};
    const missing: string[] = [];

    for (const secretRef of Object.values(profile.secretRefs)) {
      const value = this.env[secretRef];
      if (value === undefined || value.length === 0) {
        missing.push(secretRef);
        continue;
      }
      resolved[secretRef] = { ref: secretRef, value };
    }

    if (missing.length > 0) {
      return Promise.resolve(
        err(
          RunnerErrors.preconditionFailed(
            'authenticated',
            `Missing credential environment variable(s): ${missing.join(', ')}.`,
            // Names only. A value must never reach an error payload, a log or
            // the timeline (blueprint section 50).
            { profileRef: profile.ref, missing },
          ),
        ),
      );
    }

    this.logger.debug('Resolved credentials for an execution', {
      runId: executionId,
      profileRef: profile.ref,
      secretCount: Object.keys(resolved).length,
    });

    return Promise.resolve(ok(resolved));
  }
}

function parseProfiles(
  raw: string | undefined,
  logger: Logger,
): Map<string, ExecutionProfile> {
  const profiles = new Map<string, ExecutionProfile>();
  if (raw === undefined || raw.trim().length === 0) return profiles;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed profile map is a configuration error, but it must not stop a
    // worker that may have plenty of unauthenticated work to do.
    logger.error(`${PROFILES_ENV} is not valid JSON; no auth profiles were loaded.`);
    return profiles;
  }

  if (!Array.isArray(parsed)) {
    logger.error(`${PROFILES_ENV} must be a JSON array of profiles.`);
    return profiles;
  }

  for (const entry of parsed) {
    const profile = entry as Partial<ExecutionProfile>;
    if (
      typeof profile.ref !== 'string' ||
      typeof profile.workspaceRef !== 'string' ||
      typeof profile.strategy !== 'string'
    ) {
      logger.error('Skipping an auth profile without ref, workspaceRef and strategy.');
      continue;
    }

    profiles.set(keyOf(profile.workspaceRef, profile.ref), {
      ref: profile.ref,
      workspaceRef: profile.workspaceRef,
      displayName: profile.displayName ?? profile.ref,
      strategy: profile.strategy as ExecutionProfile['strategy'],
      secretRefs: profile.secretRefs ?? {},
      ...(profile.loginUrl === undefined ? {} : { loginUrl: profile.loginUrl }),
      ...(profile.formFields === undefined ? {} : { formFields: profile.formFields }),
    });
  }

  return profiles;
}

/** Profiles are scoped per workspace so two tenants can reuse a name. */
function keyOf(workspaceRef: string, profileRef: string): string {
  return `${workspaceRef}::${profileRef}`;
}
