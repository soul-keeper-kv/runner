import { type Redis } from 'ioredis';
import type { StorageStateStorePort, StoredStorageState } from '@runner/application';
import { RunnerErrors, err, ok, type Clock, type Result } from '@runner/shared';

/**
 * A Redis-backed StorageStateStorePort.
 *
 * Shared by the API and the worker for the same reason the execution store is:
 * whichever worker picks up the next run must see the session an earlier login
 * produced, or every execution would log in again and the cache would be
 * pointless.
 *
 * Expiry is Redis's own TTL. A stored session is a *cache* of an authentication
 * that already happened — letting it lapse is correct behaviour, and the login
 * is simply replayed. Keeping a stale session alive would be worse: the run
 * would start believing it was authenticated and fail somewhere further in.
 *
 * What is stored is opaque engine state, never a credential.
 */

const KEY_PREFIX = 'runner:auth-state:';

/** Matches AuthService's default trust window for a captured session. */
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

export class RedisStorageStateStore implements StorageStateStorePort {
  constructor(
    private readonly redis: Redis,
    private readonly clock: Clock,
  ) {}

  async get(
    workspaceRef: string,
    profileRef: string,
  ): Promise<Result<StoredStorageState | undefined>> {
    try {
      const raw = await this.redis.get(key(workspaceRef, profileRef));
      // A miss means "log in again", which is a normal state rather than a
      // failure, so it is reported as an absent value.
      if (raw === null) return ok(undefined);

      const stored = JSON.parse(raw) as StoredStorageState;

      // Redis should have evicted an expired entry already; this second check
      // covers a record written with a longer TTL than its own `expiresAt`.
      if (stored.expiresAt !== undefined) {
        if (new Date(stored.expiresAt).getTime() <= this.clock.now()) {
          await this.redis.del(key(workspaceRef, profileRef));
          return ok(undefined);
        }
      }

      return ok(stored);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the stored session.', cause));
    }
  }

  async save(entry: StoredStorageState): Promise<Result<void>> {
    try {
      await this.redis.set(
        key(entry.workspaceRef, entry.profileRef),
        JSON.stringify(entry),
        'EX',
        this.ttlSecondsOf(entry),
      );
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not store the captured session.', cause));
    }
  }

  async invalidate(workspaceRef: string, profileRef: string): Promise<Result<void>> {
    try {
      await this.redis.del(key(workspaceRef, profileRef));
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not invalidate the stored session.', cause));
    }
  }

  private ttlSecondsOf(entry: StoredStorageState): number {
    if (entry.expiresAt === undefined) return DEFAULT_TTL_SECONDS;

    const remainingMs = new Date(entry.expiresAt).getTime() - this.clock.now();
    if (Number.isNaN(remainingMs)) return DEFAULT_TTL_SECONDS;

    return Math.max(1, Math.ceil(remainingMs / 1000));
  }
}

/** Scoped per workspace so two tenants can use the same profile name. */
function key(workspaceRef: string, profileRef: string): string {
  return `${KEY_PREFIX}${workspaceRef}:${profileRef}`;
}
