import type { Result } from '@runner/shared';
import type { ExecutionProfile } from './secret-provider-port.js';

/**
 * Storage for auth profiles a user manages through the API
 * (blueprint section 50, deliberately relaxed).
 *
 * `SecretProviderPort` answers "what is this profile, and what are its
 * credentials" for one execution. This port is the other side: creating,
 * editing and listing profiles, so a team can point the Runner at a new
 * application without a redeploy.
 *
 * Two rules the shape enforces:
 *
 *  - **A credential goes in but never comes out.** `setSecret` accepts a value;
 *    nothing here returns one. Reads answer `secretsPresent`, so a client can
 *    show "password: set" without the value existing outside the worker that
 *    performs a login.
 *  - **The non-secret half is freely readable.** Ref, strategy, login URL and
 *    the named form fields are what a user edits and what a client displays;
 *    keeping them separate from the sealed values is what makes a profile safe
 *    to list at all.
 */

/** A profile as a client sees it: everything except the credential values. */
export interface AuthProfileView {
  readonly ref: string;
  readonly workspaceRef: string;
  readonly displayName: string;
  readonly strategy: ExecutionProfile['strategy'];
  readonly loginUrl?: string;
  /** Form field name -> the element intent name that finds it on the page. */
  readonly formFields: Readonly<Record<string, string>>;
  /**
   * Which credentials are set, by field name — never their values.
   *
   * A client renders this as "password: set" / "password: missing", which is
   * the only thing it needs and the most it may know.
   */
  readonly secretsPresent: readonly string[];
  /** Field names resolved from an external secret store instead of storage. */
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveAuthProfileInput {
  readonly ref: string;
  readonly workspaceRef: string;
  readonly displayName: string;
  readonly strategy: ExecutionProfile['strategy'];
  readonly loginUrl?: string;
  readonly formFields: Readonly<Record<string, string>>;
  /**
   * Environment-variable names for credentials kept outside the Runner.
   *
   * Preferred over a stored value when both are present: an external secret
   * store remains the better answer, and a profile can migrate to one without
   * being recreated.
   */
  readonly secretRefs?: Readonly<Record<string, string>>;
  /**
   * Credential values to seal, by form field name.
   *
   * Absent fields are left as they are, so editing a login URL does not
   * silently clear a password. Pass an empty string to remove one.
   */
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface AuthProfileStorePort {
  list(workspaceRef: string): Promise<Result<AuthProfileView[]>>;
  get(workspaceRef: string, ref: string): Promise<Result<AuthProfileView>>;
  /** Creates or replaces a profile. Returns it as a client may see it. */
  save(input: SaveAuthProfileInput): Promise<Result<AuthProfileView>>;
  delete(workspaceRef: string, ref: string): Promise<Result<void>>;

  /**
   * The profile plus its decrypted credentials, for the worker performing a
   * login.
   *
   * Deliberately a separate method from `get`: a route that wanted to list
   * profiles could not reach a credential by accident, and the one call that
   * can is easy to find when auditing.
   */
  resolveForExecution(
    workspaceRef: string,
    ref: string,
  ): Promise<Result<{ profile: ExecutionProfile; secrets: Record<string, string> }>>;
}
