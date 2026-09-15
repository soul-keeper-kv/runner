import { type Redis } from 'ioredis';
import type { SessionStorePort } from '@runner/application';
import type { LiveSession } from '@runner/live-protocol';
import { RunnerErrors, err, ok, type Clock, type Result } from '@runner/shared';

/**
 * A Redis-backed SessionStorePort shared by the API and the worker.
 *
 * This adapter is what makes a live session work at all across the two
 * processes. The API creates the session record when a client asks for one; the
 * worker reads that record before dispatching a command against the browser it
 * holds. With an in-memory store on the API side, the worker would look up a
 * session the API had just created and find nothing — the same trap the
 * execution store documents, and a harder one to diagnose because the socket
 * connects successfully first.
 *
 * Expiry is Redis's own TTL rather than a timestamp comparison in application
 * code: a live session pins a browser context, so the record must disappear on
 * its own even if every process that knew about it has died.
 */

const KEY_PREFIX = 'runner:live-session:';
const WORKSPACE_INDEX_PREFIX = 'runner:live-sessions:workspace:';

/** Fallback when a session carries no explicit expiry. */
const DEFAULT_TTL_SECONDS = 30 * 60;

export class RedisSessionStore implements SessionStorePort {
  constructor(
    private readonly redis: Redis,
    private readonly clock: Clock,
  ) {}

  async create(session: LiveSession): Promise<Result<LiveSession>> {
    try {
      const written = await this.redis.set(
        key(session.id),
        JSON.stringify(session),
        'EX',
        this.ttlSecondsOf(session),
        // NX so a reused id can never silently replace a live session that is
        // still holding a browser.
        'NX',
      );

      if (written === null) {
        return err(
          RunnerErrors.validationFailed(`Live session "${session.id}" already exists.`, {
            sessionId: session.id,
          }),
        );
      }

      // The workspace index is a convenience for listing; it is allowed to hold
      // ids whose records have expired, and reads filter those out.
      await this.redis.sadd(workspaceKey(session.workspaceRef), session.id);
      return ok(session);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not persist the live session.', cause));
    }
  }

  async get(sessionId: string): Promise<Result<LiveSession>> {
    try {
      const raw = await this.redis.get(key(sessionId));
      if (raw === null) return err(RunnerErrors.liveSessionLost(sessionId));
      return ok(JSON.parse(raw) as LiveSession);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not read the live session.', cause));
    }
  }

  /**
   * Applies a patch and increments `revision`.
   *
   * Revision is owned by the store, never by the caller: clients rely on it to
   * detect an update they missed, so a caller that could set it would be able to
   * make a stale view look current.
   */
  async update(
    sessionId: string,
    patch: Partial<Omit<LiveSession, 'id' | 'revision'>>,
  ): Promise<Result<LiveSession>> {
    try {
      const existing = await this.get(sessionId);
      if (!existing.ok) return existing;

      const updated: LiveSession = {
        ...existing.value,
        ...patch,
        revision: existing.value.revision + 1,
        updatedAt: this.clock.nowIso(),
      };

      // KEEPTTL: an update is not a reason to extend a session's life. Only
      // `touch` does that, so an idle-but-busy session cannot live forever by
      // being written to.
      await this.redis.set(key(sessionId), JSON.stringify(updated), 'KEEPTTL');
      return ok(updated);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not update the live session.', cause));
    }
  }

  async delete(sessionId: string): Promise<Result<void>> {
    try {
      const existing = await this.get(sessionId);
      await this.redis.del(key(sessionId));
      if (existing.ok) {
        await this.redis.srem(workspaceKey(existing.value.workspaceRef), sessionId);
      }
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not delete the live session.', cause));
    }
  }

  async listByWorkspace(workspaceRef: string): Promise<Result<LiveSession[]>> {
    try {
      const ids = await this.redis.smembers(workspaceKey(workspaceRef));
      if (ids.length === 0) return ok([]);

      const raws = await this.redis.mget(ids.map(key));
      const sessions: LiveSession[] = [];
      const expired: string[] = [];

      ids.forEach((sessionId, index) => {
        const raw = raws[index];
        if (raw === null || raw === undefined) {
          expired.push(sessionId);
          return;
        }
        sessions.push(JSON.parse(raw) as LiveSession);
      });

      // Opportunistic cleanup: the index would otherwise grow without bound as
      // sessions expire out from under it.
      if (expired.length > 0) {
        await this.redis.srem(workspaceKey(workspaceRef), ...expired);
      }

      return ok(sessions);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not list live sessions.', cause));
    }
  }

  async touch(sessionId: string): Promise<Result<void>> {
    try {
      const existing = await this.get(sessionId);
      if (!existing.ok) return existing;

      const ttlSeconds = this.ttlSecondsOf(existing.value);
      const extended = new Date(this.clock.now() + ttlSeconds * 1000).toISOString();

      // The stored `expiresAt` is advanced alongside the Redis TTL so a client
      // reading the record sees the same deadline the store will enforce.
      await this.redis.set(
        key(sessionId),
        JSON.stringify({ ...existing.value, expiresAt: extended }),
        'EX',
        ttlSeconds,
      );
      return ok(undefined);
    } catch (cause) {
      return err(RunnerErrors.internal('Could not extend the live session.', cause));
    }
  }

  /** Seconds until the session's own expiry, floored so a TTL is never zero. */
  private ttlSecondsOf(session: LiveSession): number {
    if (session.expiresAt === undefined) return DEFAULT_TTL_SECONDS;

    const remainingMs = new Date(session.expiresAt).getTime() - this.clock.now();
    if (Number.isNaN(remainingMs)) return DEFAULT_TTL_SECONDS;

    return Math.max(1, Math.ceil(remainingMs / 1000));
  }
}

function key(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

function workspaceKey(workspaceRef: string): string {
  return `${WORKSPACE_INDEX_PREFIX}${workspaceRef}`;
}
