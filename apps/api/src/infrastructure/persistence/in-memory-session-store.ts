import type { SessionStorePort } from '@runner/application';
import type { LiveSession } from '@runner/live-protocol';
import { RunnerErrors, err, ok, type Clock, type Result } from '@runner/shared';

/**
 * An in-memory SessionStorePort, mirroring the Redis adapter's semantics —
 * including TTL expiry, so code written against it does not break when the real
 * store starts evicting sessions.
 */
export class InMemorySessionStore implements SessionStorePort {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(private readonly clock: Clock) {}

  create(session: LiveSession): Promise<Result<LiveSession>> {
    this.sessions.set(session.id, session);
    return Promise.resolve(ok(session));
  }

  get(sessionId: string): Promise<Result<LiveSession>> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return Promise.resolve(err(RunnerErrors.liveSessionLost(sessionId)));

    if (this.isExpired(session)) {
      this.sessions.delete(sessionId);
      return Promise.resolve(err(RunnerErrors.liveSessionLost(sessionId)));
    }
    return Promise.resolve(ok(session));
  }

  update(
    sessionId: string,
    patch: Partial<Omit<LiveSession, 'id' | 'revision'>>,
  ): Promise<Result<LiveSession>> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return Promise.resolve(err(RunnerErrors.liveSessionLost(sessionId)));

    // Revision is owned by the store, never by the caller: clients rely on it
    // to detect updates they missed.
    const updated: LiveSession = {
      ...session,
      ...patch,
      revision: session.revision + 1,
      updatedAt: this.clock.nowIso(),
    };
    this.sessions.set(sessionId, updated);
    return Promise.resolve(ok(updated));
  }

  delete(sessionId: string): Promise<Result<void>> {
    this.sessions.delete(sessionId);
    return Promise.resolve(ok(undefined));
  }

  listByWorkspace(workspaceRef: string): Promise<Result<LiveSession[]>> {
    const sessions = [...this.sessions.values()].filter(
      (session) => session.workspaceRef === workspaceRef && !this.isExpired(session),
    );
    return Promise.resolve(ok(sessions));
  }

  touch(sessionId: string): Promise<Result<void>> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return Promise.resolve(err(RunnerErrors.liveSessionLost(sessionId)));

    if (session.expiresAt !== undefined) {
      const ttlMs = new Date(session.expiresAt).getTime() - new Date(session.updatedAt).getTime();
      this.sessions.set(sessionId, {
        ...session,
        updatedAt: this.clock.nowIso(),
        expiresAt: new Date(this.clock.now() + ttlMs).toISOString(),
      });
    }
    return Promise.resolve(ok(undefined));
  }

  private isExpired(session: LiveSession): boolean {
    return session.expiresAt !== undefined && new Date(session.expiresAt).getTime() < this.clock.now();
  }
}
