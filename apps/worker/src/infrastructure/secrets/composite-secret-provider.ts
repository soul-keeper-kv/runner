import type {
  AuthProfileStorePort,
  ExecutionProfile,
  ResolvedSecret,
  SecretProviderPort,
} from '@runner/application';
import { ok, type Logger, type Result } from '@runner/shared';

/**
 * Resolves a profile from managed storage first, then from the environment.
 *
 * Both mechanisms are legitimate and they solve different problems. A profile
 * stored through the API lets a team point the Runner at a new application
 * without a redeploy — the reason this exists. `RUNNER_AUTH_PROFILES` remains
 * the answer for a deployment that will not put a credential in its database at
 * all, and for local development with no Postgres.
 *
 * Storage wins when a profile is defined in both, because that is the one a
 * user just edited and expects to take effect. The environment is the fallback,
 * and a profile found in neither reports the *environment* provider's error: it
 * names `RUNNER_AUTH_PROFILES` and tells a developer exactly what to declare,
 * which is more useful than "not found in the database".
 */
export class CompositeSecretProvider implements SecretProviderPort {
  constructor(
    private readonly store: AuthProfileStorePort,
    private readonly fallback: SecretProviderPort,
    private readonly logger: Logger,
  ) {}

  /**
   * Caches what `getProfile` resolved, so `resolveSecrets` decrypts once.
   *
   * Keyed per workspace and ref rather than held as a single field: two
   * executions run concurrently in this process, and one overwriting the
   * other's profile would make a run authenticate as the wrong user.
   */
  private readonly resolved = new Map<string, Record<string, string>>();

  async getProfile(workspaceRef: string, profileRef: string): Promise<Result<ExecutionProfile>> {
    const stored = await this.store.resolveForExecution(workspaceRef, profileRef);

    if (stored.ok) {
      this.resolved.set(keyOf(workspaceRef, profileRef), stored.value.secrets);
      this.logger.debug('Profile resolved from managed storage', { profileRef });
      return ok(stored.value.profile);
    }

    this.logger.debug('No managed profile; falling back to the environment', {
      profileRef,
      reason: stored.error.code,
    });
    return this.fallback.getProfile(workspaceRef, profileRef);
  }

  /**
   * Returns the credentials for a profile, from wherever it came from.
   *
   * A stored profile's values were decrypted by `getProfile`; anything it did
   * not supply is looked up in the environment, so a profile may mix the two —
   * a password stored here, an API token still held in a vault-backed variable.
   */
  async resolveSecrets(
    profile: ExecutionProfile,
    executionId: string,
  ): Promise<Result<Record<string, ResolvedSecret>>> {
    const stored = this.resolved.get(keyOf(profile.workspaceRef, profile.ref));

    if (stored === undefined) {
      return this.fallback.resolveSecrets(profile, executionId);
    }

    const secrets: Record<string, ResolvedSecret> = {};
    for (const [ref, value] of Object.entries(stored)) {
      secrets[ref] = { ref, value };
    }

    // Any reference the stored profile did not cover — an external secret
    // store's variable name — still has to be resolved from the environment.
    const missing = Object.values(profile.secretRefs).filter(
      (ref) => secrets[ref] === undefined,
    );

    if (missing.length > 0) {
      const fromEnv = await this.fallback.resolveSecrets(profile, executionId);
      if (!fromEnv.ok) return fromEnv;
      Object.assign(secrets, fromEnv.value);
    }

    this.logger.debug('Resolved credentials for an execution', {
      runId: executionId,
      profileRef: profile.ref,
      // Counts and names only, never a value.
      secretCount: Object.keys(secrets).length,
    });

    return ok(secrets);
  }
}

function keyOf(workspaceRef: string, profileRef: string): string {
  return `${workspaceRef}::${profileRef}`;
}
