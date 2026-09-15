import type { Result } from '@runner/shared';

/**
 * Stores the authenticated browser state a profile produced
 * (blueprint section 9).
 *
 * The point of this port is that a UI login happens *once* rather than at the
 * start of every run. A form login is slow, it is the most brittle thing the
 * Runner does, and replaying it per execution means a login-page change breaks
 * every test at once instead of one fixture.
 *
 * What is stored is opaque engine state — cookies and origin storage — never a
 * credential. The password lives in the secret provider, is used for the single
 * login that produced this state, and is never written here.
 */

export interface StoredStorageState {
  readonly workspaceRef: string;
  readonly profileRef: string;
  /** Engine-owned serialized state, passed back to a browser launch as-is. */
  readonly state: unknown;
  readonly capturedAt: string;
  /** After this, the state is treated as stale and the login is replayed. */
  readonly expiresAt?: string;
}

export interface StorageStateStorePort {
  /**
   * Returns the stored state, or undefined when there is none to reuse.
   *
   * An expired entry answers `undefined` rather than an error: a stale session
   * is a normal condition that means "log in again", not a failure.
   */
  get(workspaceRef: string, profileRef: string): Promise<Result<StoredStorageState | undefined>>;
  save(entry: StoredStorageState): Promise<Result<void>>;
  /** Drops a profile's state, forcing the next run to authenticate again. */
  invalidate(workspaceRef: string, profileRef: string): Promise<Result<void>>;
}
