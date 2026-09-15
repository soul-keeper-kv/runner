import type { LiveSession } from '@runner/live-protocol';
import {
  RunnerErrors,
  err,
  newId,
  newLiveSessionId,
  ok,
  type Clock,
  type Logger,
  type Result,
} from '@runner/shared';
import type { SessionStorePort } from '../ports/session-store-port.js';

/**
 * Live session lifecycle (blueprint sections 26 and 52.4).
 *
 * Creating a session reserves a browser identity; the worker attaches the real
 * browser to it. Keeping the record here rather than inside the worker means a
 * session survives a worker restart as a record, and the API can answer
 * questions about it without reaching into worker memory.
 */

export interface LiveSessionDeps {
  readonly sessions: SessionStorePort;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface StartLiveSessionInput {
  readonly workspaceRef: string;
  readonly executionId?: string;
  /**
   * Opens the session authenticated as this execution profile, so a live view
   * can reach a page that only exists behind a login.
   *
   * A reference, never a credential. The worker resolves it against its secret
   * provider; the API never sees a password, and neither does the client that
   * asked for the session.
   */
  readonly authProfileRef?: string;
  /** Session lifetime; live sessions hold a browser, so they must expire. */
  readonly ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 30 * 60;

export async function startLiveSession(
  deps: LiveSessionDeps,
  input: StartLiveSessionInput,
): Promise<Result<LiveSession>> {
  const now = deps.clock.now();
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const session: LiveSession = {
    id: newLiveSessionId(),
    workspaceRef: input.workspaceRef,
    browserSessionId: newId('bs'),
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    ...(input.authProfileRef === undefined ? {} : { authProfileRef: input.authProfileRef }),
    executionState: 'IDLE',
    revision: 0,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };

  const created = await deps.sessions.create(session);
  if (!created.ok) return created;

  deps.logger.info('Live session started', {
    sessionId: session.id,
    workspaceRef: input.workspaceRef,
    // The profile ref is safe to log; the credential it points at never
    // reaches this process.
    ...(input.authProfileRef === undefined ? {} : { authProfileRef: input.authProfileRef }),
  });
  return ok(created.value);
}

export async function getLiveSession(
  deps: LiveSessionDeps,
  sessionId: string,
): Promise<Result<LiveSession>> {
  const found = await deps.sessions.get(sessionId);
  if (!found.ok) return found;

  if (found.value.executionState === 'CLOSED') {
    return err(RunnerErrors.liveSessionLost(sessionId));
  }
  return found;
}

export async function closeLiveSession(
  deps: LiveSessionDeps,
  sessionId: string,
): Promise<Result<void>> {
  const updated = await deps.sessions.update(sessionId, {
    executionState: 'CLOSED',
    updatedAt: deps.clock.nowIso(),
  });
  if (!updated.ok) return updated;

  deps.logger.info('Live session closed', { sessionId });
  return ok(undefined);
}
