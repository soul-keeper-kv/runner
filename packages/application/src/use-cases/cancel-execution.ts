import { isTerminalStatus } from '@runner/test-ir-model';
import { RunnerErrors, err, ok, type Clock, type Logger, type Result } from '@runner/shared';
import type { ExecutionQueuePort } from '../ports/execution-queue-port.js';
import type { ExecutionStorePort } from '../ports/execution-store-port.js';

export interface CancelExecutionDeps {
  readonly store: ExecutionStorePort;
  readonly queue: ExecutionQueuePort;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Requests cancellation of a queued or running execution.
 *
 * Cancellation is cooperative: a queued job is removed outright, while a
 * running one stops at its next step boundary. Killing a worker mid-action
 * would leave a browser context and its artifacts orphaned.
 */
export async function cancelExecution(
  deps: CancelExecutionDeps,
  executionId: string,
): Promise<Result<{ readonly executionId: string; readonly status: string }>> {
  const found = await deps.store.get(executionId);
  if (!found.ok) return found;

  const record = found.value;

  if (isTerminalStatus(record.status)) {
    return err(
      RunnerErrors.validationFailed(
        `Execution "${executionId}" already finished with status ${record.status}.`,
        { executionId, status: record.status },
      ),
    );
  }

  const cancelled = await deps.queue.cancel(executionId);
  if (!cancelled.ok) {
    deps.logger.warn('Queue cancellation failed; marking the record anyway', {
      runId: executionId,
      errorCode: cancelled.error.code,
    });
  }

  const updated = await deps.store.updateStatus(executionId, 'CANCELLED', {
    completedAt: deps.clock.nowIso(),
  });
  if (!updated.ok) return updated;

  deps.logger.info('Execution cancelled', { runId: executionId });
  return ok({ executionId, status: 'CANCELLED' });
}
