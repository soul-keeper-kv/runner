import type { BrowserPort, ExecutionStorePort, RegistryPort } from '@runner/application';
import type {
  ExecutionContext,
  ExecutionPlan,
  PageSnapshot,
  ResolvedElement,
  TestAction,
} from '@runner/domain';
import { actionNeedsTarget } from '@runner/domain';
import { describeSelector, type ScopedSelector } from '@runner/selector-model';
import type { ExecutionStatus } from '@runner/test-ir-model';
import { type RunnerError, RunnerErrors, ok, type Clock, type Logger, type Result } from '@runner/shared';
import { type SessionManager } from '../../modules/session/session-manager.js';
import { type DomInspector } from '../../modules/inspector/dom-inspector.js';
import { type DeterministicElementResolver } from '../../modules/resolver/element-resolver.js';
import { type StateObserver } from '../../modules/observer/state-observer.js';
import { type PreconditionEngine } from '../../modules/state/precondition-engine.js';
import { type HealingEngine } from '../../modules/healing/healing-engine.js';
import { TimelineBuilder } from '../../modules/timeline/timeline-builder.js';

/**
 * Runs one execution end to end (blueprint section 6).
 *
 * The pipeline per step is: preconditions -> inspect -> resolve -> execute ->
 * observe -> record. Two properties of this loop matter more than the steps
 * themselves.
 *
 * First, a step is re-inspected before resolution rather than resolved against
 * a snapshot taken at the start of the run. A page changes as a test drives it,
 * and resolving against a stale snapshot is how automation clicks something
 * that has since moved.
 *
 * Second, failures are values. A failed step records its error and evidence in
 * the timeline and the loop decides whether to continue, instead of an
 * exception unwinding the run and losing the record of what happened.
 */

export interface RunExecutionDeps {
  readonly store: ExecutionStorePort;
  readonly sessions: SessionManager;
  readonly inspector: DomInspector;
  readonly resolver: DeterministicElementResolver;
  readonly observer: StateObserver;
  readonly preconditions: PreconditionEngine;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Optional, and only consulted when a step names a *registry* element whose
   * stored selector stopped matching. Both are absent in tests that do not
   * exercise healing.
   */
  readonly healing?: HealingEngine;
  readonly registry?: RegistryPort;
}

export async function runExecution(
  deps: RunExecutionDeps,
  plan: ExecutionPlan,
): Promise<Result<ExecutionStatus>> {
  const logger = deps.logger.child({ runId: plan.executionId });
  const timeline = new TimelineBuilder(deps.clock);

  await deps.store.updateStatus(plan.executionId, 'RUNNING', { startedAt: deps.clock.nowIso() });
  logger.info('Execution started', { steps: plan.actions.length, mode: plan.mode });

  const acquired = await deps.sessions.acquireForPlan(plan);
  if (!acquired.ok) {
    await failExecution(deps, plan.executionId, acquired.error);
    return acquired;
  }

  const { browser, authenticatedAs } = acquired.value;
  let context: ExecutionContext = {
    executionId: plan.executionId,
    plan,
    browserSessionId: browser.sessionId,
    applicationState: [],
    // Set only when a stored session was actually applied at launch. The
    // `authenticated` precondition reads this to decide whether a login is
    // still needed, so claiming it unearned would skip a required login.
    ...(authenticatedAs === undefined ? {} : { authenticatedAs }),
    startedAt: deps.clock.nowIso(),
  };

  let failed = false;

  try {
    for (const action of plan.actions) {
      // Once the run has failed and stopOnFailure is set, remaining steps are
      // recorded as SKIPPED rather than silently omitted, so the timeline
      // still accounts for every step the caller submitted.
      if (failed && plan.options.stopOnFailure) {
        const skipped = timeline.skip(action.id, 'Skipped after an earlier step failed.');
        await deps.store.upsertTimelineItem(plan.executionId, skipped);
        continue;
      }

      timeline.start(action.id, action.type, action.label);
      await deps.store.upsertTimelineItem(plan.executionId, timeline.get(action.id)!);

      context = { ...context, currentAction: action };
      const outcome = await runStep(deps, browser, context, action, logger);

      if (outcome.ok) {
        const item = timeline.complete(action.id, 'PASSED', {
          evidence: outcome.value.evidence,
          ...(outcome.value.resolvedElement === undefined
            ? {}
            : { resolvedElement: outcome.value.resolvedElement }),
        });
        await deps.store.upsertTimelineItem(plan.executionId, item);
        continue;
      }

      const item = timeline.complete(action.id, 'FAILED', { error: outcome.error });
      await deps.store.upsertTimelineItem(plan.executionId, item);

      logger.warn('Step failed', {
        stepId: action.id,
        errorCode: outcome.error.code,
        result: outcome.error.kind,
      });

      if (!action.continueOnFailure) failed = true;
    }
  } finally {
    await deps.sessions.release(browser.sessionId);
  }

  const status: ExecutionStatus = failed ? 'FAILED' : 'PASSED';
  await deps.store.updateStatus(plan.executionId, status, {
    completedAt: deps.clock.nowIso(),
  });

  logger.info('Execution finished', { result: status });
  return ok(status);
}

interface StepOutcome {
  readonly evidence: string[];
  readonly resolvedElement?: ResolvedElement;
}

async function runStep(
  deps: RunExecutionDeps,
  browser: BrowserPort,
  context: ExecutionContext,
  action: TestAction,
  logger: Logger,
): Promise<Result<StepOutcome>> {
  const evidence: string[] = [];

  // --- preconditions -----------------------------------------------------
  if (action.preconditions.length > 0) {
    const satisfied = await deps.preconditions.satisfy(action.preconditions, context);
    if (!satisfied.ok) return satisfied;
    evidence.push(`${action.preconditions.length} precondition(s) satisfied`);
  }

  // --- state before, so the observer can tell what the action changed ----
  const before = await deps.observer.capture(browser);
  if (!before.ok) return before;

  // --- resolve the target ------------------------------------------------
  let resolvedElement: ResolvedElement | undefined;
  let scopedSelector: ScopedSelector | undefined;

  if (actionNeedsTarget(action.type)) {
    if (action.target === undefined) {
      return {
        ok: false,
        error: RunnerErrors.validationFailed(`Step "${action.id}" has no target.`),
      };
    }

    // An assertion reads the page; it does not drive it. Headings, labels,
    // status badges and error messages are exactly what tests assert on, and
    // none of them is interactable — so assert steps widen the snapshot to all
    // visible elements and drop the interactability requirement. Requiring it
    // would make a heading unresolvable and push the resolver into a low
    // confidence guess at some nearby button.
    const isAssertion = action.type === 'assert';

    // Inspected per step: the page has changed since the previous one.
    const snapshot = await deps.inspector.inspect(browser, {
      interactableOnly: !isAssertion,
    });
    if (!snapshot.ok) return snapshot;

    const resolved = await deps.resolver.resolve({
      intent: action.target,
      snapshot: snapshot.value,
      browser,
      requireInteractable: !isAssertion,
      requireEditable: action.type === 'fill',
    });

    if (!resolved.ok) {
      /*
       * Phase 12: a registry-backed target that will not resolve is the one case
       * worth healing. Healing *proposes* a replacement and records it; it never
       * rewrites the Registry here, and it never rescues this step — the run
       * still fails, with the proposal attached as evidence.
       *
       * Rescuing the step would be the tempting mistake: a test that passes
       * because the Runner quietly repaired its own mapping hides the UI change
       * that caused it, which is precisely what a reviewer needs to see.
       */
      await proposeHealing(deps, action, context, browser, snapshot.value, evidence);
      return resolved;
    }

    resolvedElement = resolved.value;
    scopedSelector = { selector: resolved.value.locator };
    evidence.push(...resolved.value.evidence.map((item) => item.reason));

    logger.debug('Target resolved', {
      stepId: action.id,
      confidence: resolved.value.confidence,
      selectorStrategy: resolved.value.locator.type,
    });
  }

  // --- execute -----------------------------------------------------------
  const executed = await browser.execute(action, scopedSelector, context);
  if (!executed.ok) return executed;
  evidence.push(...executed.value.evidence);

  // --- observe -----------------------------------------------------------
  const change = await deps.observer.observe(browser, before.value);
  if (change.ok) {
    if (change.value.urlChanged) {
      evidence.push(`url changed to ${change.value.after.url}`);
    } else if (change.value.domChanged) {
      evidence.push('dom changed');
    }
  }

  return ok({
    evidence,
    ...(resolvedElement === undefined ? {} : { resolvedElement }),
  });
}

/**
 * Asks the healing engine for a replacement selector, recording the outcome as
 * step evidence.
 *
 * Deliberately best-effort and side-effect-only: anything that goes wrong here
 * is logged and dropped, because a failure to *propose* a fix must not change
 * how the underlying step failure is reported.
 */
async function proposeHealing(
  deps: RunExecutionDeps,
  action: TestAction,
  context: ExecutionContext,
  browser: BrowserPort,
  snapshot: PageSnapshot,
  evidence: string[],
): Promise<void> {
  const { healing, registry } = deps;
  const elementId = action.target?.elementId;

  // Healing replaces a *stored* selector, so it only applies to a target that
  // names one. A DOM-discovered target has nothing to heal.
  if (healing === undefined || registry === undefined || elementId === undefined) return;
  if (!context.plan.options.enableSelfHealing) return;

  const element = await registry.findElementById(context.plan.workspaceRef, elementId);
  if (!element.ok) return;

  const proposal = await healing.proposeReplacement({
    element: element.value,
    snapshot,
    browser,
    executionId: context.executionId,
    mode: context.plan.mode,
  });

  if (!proposal.ok) {
    deps.logger.debug('Healing found no replacement', {
      runId: context.executionId,
      elementId,
      errorCode: proposal.error.code,
    });
    return;
  }

  evidence.push(
    `healing proposed ${describeSelector(proposal.value.replacement)} (modification ${proposal.value.modification.id}, confidence ${proposal.value.confidence})`,
    proposal.value.autoCommittable
      ? 'the proposal is auto-committable under this workspace policy'
      : 'the proposal is waiting for review',
  );

  deps.logger.info('Healing proposed a replacement', {
    runId: context.executionId,
    elementId,
    modificationId: proposal.value.modification.id,
    confidence: proposal.value.confidence,
  });
}

async function failExecution(
  deps: RunExecutionDeps,
  executionId: string,
  error: RunnerError,
): Promise<void> {
  await deps.store.updateStatus(executionId, 'FAILED', {
    completedAt: deps.clock.nowIso(),
    error: error.toJSON(),
  });
}
