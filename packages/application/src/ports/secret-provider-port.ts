import type { Result } from '@runner/shared';

/**
 * Credential access (blueprint section 50).
 *
 * Two rules are encoded in this shape. Test IR carries a *profile reference*,
 * never a password; and a resolved credential is scoped to one execution, so a
 * worker holds only what the current run needs.
 */

export interface ExecutionProfile {
  readonly ref: string;
  readonly workspaceRef: string;
  readonly displayName: string;
  /** How the Runner authenticates this profile. */
  readonly strategy: 'FORM_LOGIN' | 'API_TOKEN' | 'COOKIE' | 'STORAGE_STATE' | 'OAUTH' | 'SSO';
  /** Opaque secret identifiers, resolved separately and never logged. */
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly loginUrl?: string;
  /** Element intents used by a UI login flow, resolved via the Registry. */
  readonly formFields?: Readonly<Record<string, string>>;
}

export interface ResolvedSecret {
  readonly ref: string;
  readonly value: string;
}

export interface SecretProviderPort {
  getProfile(workspaceRef: string, profileRef: string): Promise<Result<ExecutionProfile>>;
  /** Resolves only the secrets named by a profile, for one execution. */
  resolveSecrets(
    profile: ExecutionProfile,
    executionId: string,
  ): Promise<Result<Record<string, ResolvedSecret>>>;
}
