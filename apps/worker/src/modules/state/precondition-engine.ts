import type { ExecutionContext, Precondition, PreconditionOutcome } from '@runner/domain';
import { RunnerErrors, ok, type Logger, type Result } from '@runner/shared';

/**
 * Prepares required state before a step runs (blueprint section 19).
 *
 * The design point is the separation of *failure kinds*: if a precondition
 * cannot be reached, the run fails with PRECONDITION_FAILED, never
 * TEST_FAILED. Reporting a broken fixture as a failing test is how teams learn
 * to ignore their test results.
 *
 * Handlers are registered rather than hardcoded so each precondition type —
 * authentication, entity state, UI state — can arrive in its own phase.
 */
export interface StateHandler {
  readonly type: string;
  canHandle(precondition: Precondition): boolean;
  isSatisfied(precondition: Precondition, context: ExecutionContext): Promise<Result<boolean>>;
  prepare(precondition: Precondition, context: ExecutionContext): Promise<Result<void>>;
}

export class PreconditionEngine {
  private readonly handlers: StateHandler[] = [];

  constructor(private readonly logger: Logger) {}

  register(handler: StateHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Satisfies every precondition, preparing state where needed.
   *
   * Each prepared precondition is re-checked rather than assumed: a handler
   * that ran without throwing has still not proven the state was reached.
   */
  async satisfy(
    preconditions: readonly Precondition[],
    context: ExecutionContext,
  ): Promise<Result<PreconditionOutcome[]>> {
    const outcomes: PreconditionOutcome[] = [];

    for (const precondition of preconditions) {
      const handler = this.handlers.find((candidate) => candidate.canHandle(precondition));

      if (handler === undefined) {
        return {
          ok: false,
          error: RunnerErrors.preconditionFailed(
            precondition.type,
            `No handler is registered for precondition type "${precondition.type}".`,
          ),
        };
      }

      const satisfied = await handler.isSatisfied(precondition, context);
      if (!satisfied.ok) return satisfied;

      if (satisfied.value) {
        outcomes.push({ kind: 'ALREADY_SATISFIED' });
        continue;
      }

      const prepared = await handler.prepare(precondition, context);
      if (!prepared.ok) return prepared;

      const recheck = await handler.isSatisfied(precondition, context);
      if (!recheck.ok) return recheck;

      if (!recheck.value) {
        return {
          ok: false,
          error: RunnerErrors.preconditionFailed(
            precondition.type,
            'The state was prepared but the precondition is still not satisfied.',
          ),
        };
      }

      this.logger.info('Precondition prepared', {
        runId: context.executionId,
        preconditionType: precondition.type,
      });
      outcomes.push({ kind: 'PREPARED', actionsTaken: [handler.type] });
    }

    return ok(outcomes);
  }
}
