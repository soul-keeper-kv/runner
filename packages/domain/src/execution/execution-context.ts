import type { ExecutionPlan, TestAction } from './test-action.js';
import type { PageSnapshot } from '../page/page-snapshot.js';

/**
 * The state threaded through one execution.
 *
 * Passed explicitly rather than held in module scope so that two executions,
 * or an execution and a live session, never observe each other's browser.
 */
export interface ExecutionContext {
  readonly executionId: string;
  readonly plan: ExecutionPlan;
  readonly browserSessionId: string;
  readonly liveSessionId?: string;

  /** The step currently being prepared or executed. */
  readonly currentAction?: TestAction;
  /** Most recent snapshot; re-inspection is expensive, so it is cached here. */
  readonly snapshot?: PageSnapshot;
  /** Application state names currently believed to hold, e.g. ORDER_SUBMITTED. */
  readonly applicationState: readonly string[];
  /** Auth profile the browser context is currently authenticated as. */
  readonly authenticatedAs?: string;

  readonly startedAt: string;
}

export interface ActionResult {
  readonly status: 'PASSED' | 'FAILED' | 'SKIPPED';
  readonly durationMs: number;
  readonly evidence: readonly string[];
  readonly artifactIds: readonly string[];
}

export function withSnapshot(
  context: ExecutionContext,
  snapshot: PageSnapshot,
): ExecutionContext {
  return { ...context, snapshot };
}

export function withCurrentAction(
  context: ExecutionContext,
  action: TestAction,
): ExecutionContext {
  return { ...context, currentAction: action };
}

export function withApplicationState(
  context: ExecutionContext,
  states: readonly string[],
): ExecutionContext {
  return { ...context, applicationState: states };
}
