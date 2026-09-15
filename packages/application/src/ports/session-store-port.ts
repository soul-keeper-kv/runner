import type { LiveSession } from '@runner/live-protocol';
import type { Result } from '@runner/shared';

/** Live session persistence, typically Redis-backed with a TTL. */
export interface SessionStorePort {
  create(session: LiveSession): Promise<Result<LiveSession>>;
  get(sessionId: string): Promise<Result<LiveSession>>;
  /** Applies a patch and increments `revision` atomically. */
  update(
    sessionId: string,
    patch: Partial<Omit<LiveSession, 'id' | 'revision'>>,
  ): Promise<Result<LiveSession>>;
  delete(sessionId: string): Promise<Result<void>>;
  listByWorkspace(workspaceRef: string): Promise<Result<LiveSession[]>>;
  /** Extends the TTL of an active session. */
  touch(sessionId: string): Promise<Result<void>>;
}
