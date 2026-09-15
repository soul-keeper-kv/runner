/**
 * The live session model (blueprint sections 25, 26).
 *
 * A LiveSession is a *held-open* browser state. Its whole reason to exist is
 * that editing a selector must not restart the browser: cookies, the open
 * modal, the half-filled form and the scroll position all survive an edit, so
 * the user validates against the state that actually caused the problem.
 */

export const LIVE_EXECUTION_STATES = [
  'IDLE',
  'RUNNING',
  'PAUSED',
  'WAITING_USER',
  'FAILED',
  'CLOSED',
] as const;

export type LiveExecutionState = (typeof LIVE_EXECUTION_STATES)[number];

export interface LiveSession {
  readonly id: string;
  readonly workspaceRef: string;
  readonly browserSessionId: string;
  /** Set when the session is attached to a queued/running execution. */
  readonly executionId?: string;

  readonly executionState: LiveExecutionState;
  readonly currentStepId?: string;
  readonly selectedElementId?: string;

  /** Incremented on every applied command, so clients can detect lost updates. */
  readonly revision: number;

  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export function isLiveSessionAlive(session: LiveSession): boolean {
  return session.executionState !== 'CLOSED';
}

export function canAcceptCommands(session: LiveSession): boolean {
  return isLiveSessionAlive(session) && session.executionState !== 'RUNNING';
}
