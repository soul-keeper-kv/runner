import type { ExecutionResultV1 } from '@runner/test-ir-model';
import { ok, type Result } from '@runner/shared';
import type { ExecutionStorePort } from '../ports/execution-store-port.js';
import { toExecutionResult } from '../mappers/outbound-result-mapper.js';

export interface GetExecutionDeps {
  readonly store: ExecutionStorePort;
}

/** Backs GET /api/v1/executions/:id — the polling integration style. */
export async function getExecution(
  deps: GetExecutionDeps,
  executionId: string,
): Promise<Result<ExecutionResultV1>> {
  const found = await deps.store.get(executionId);
  if (!found.ok) return found;
  return ok(toExecutionResult(found.value));
}
