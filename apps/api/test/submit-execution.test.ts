import { describe, expect, it } from 'vitest';
import { submitExecution } from '@runner/application';
import type { ExecutionRequestV1 } from '@runner/test-ir-model';
import { fixedClock, noopLogger } from '@runner/shared';
import { InMemoryExecutionStore } from '../src/infrastructure/persistence/in-memory-execution-store.js';
import { InMemoryExecutionQueue } from '../src/infrastructure/queue/in-memory-execution-queue.js';

/**
 * Exercises the submission path through real adapters rather than mocks, so
 * the test covers the wiring as well as the use case.
 */
function deps() {
  return {
    store: new InMemoryExecutionStore(),
    queue: new InMemoryExecutionQueue(noopLogger),
    clock: fixedClock('2026-01-01T00:00:00.000Z'),
    logger: noopLogger,
  };
}

function request(overrides: Partial<ExecutionRequestV1> = {}): ExecutionRequestV1 {
  return {
    contractVersion: 'runner.execution.v1',
    irVersion: 'test-ir.v1',
    workspaceRef: 'workspace_demo',
    test: {
      id: 'tc-1',
      name: 'Login',
      steps: [
        { id: 's1', type: 'goto', value: '/login' },
        { id: 's2', type: 'click', target: { name: 'Login Button' } },
      ],
    },
    ...overrides,
  } as ExecutionRequestV1;
}

describe('submitExecution', () => {
  it('accepts a valid request and queues exactly one job', async () => {
    const d = deps();
    const result = await submitExecution(d, { request: request() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('QUEUED');
    expect(result.value.executionId).toMatch(/^run_/);
    expect(result.value.statusUrl).toBe(`/api/v1/executions/${result.value.executionId}`);
    expect(d.queue.pending()).toHaveLength(1);
  });

  it('stores the submitted payload verbatim for audit and replay', async () => {
    const d = deps();
    const submitted = request({ requestId: 'req_1' });
    const accepted = await submitExecution(d, { request: submitted });
    if (!accepted.ok) throw new Error('expected acceptance');

    const record = await d.store.get(accepted.value.executionId);
    expect(record.ok).toBe(true);
    if (!record.ok) return;

    expect(record.value.irSnapshot).toEqual(submitted);
  });

  it('seeds one pending timeline item per step so nothing is unaccounted for', async () => {
    const d = deps();
    const accepted = await submitExecution(d, { request: request() });
    if (!accepted.ok) throw new Error('expected acceptance');

    const record = await d.store.get(accepted.value.executionId);
    if (!record.ok) return;

    expect(record.value.timeline).toHaveLength(2);
    expect(record.value.timeline.every((item) => item.status === 'PENDING')).toBe(true);
  });

  it('returns the original execution for a repeated idempotency key', async () => {
    const d = deps();
    const first = await submitExecution(d, { request: request(), idempotencyKey: 'key-1' });
    const second = await submitExecution(d, { request: request(), idempotencyKey: 'key-1' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // A retried request must never start a second browser run.
    expect(second.value.executionId).toBe(first.value.executionId);
    expect(d.queue.pending()).toHaveLength(1);
  });

  it('scopes idempotency keys per workspace so tenants cannot collide', async () => {
    const d = deps();
    const a = await submitExecution(d, {
      request: request({ workspaceRef: 'workspace_a' }),
      idempotencyKey: 'shared-key',
    });
    const b = await submitExecution(d, {
      request: request({ workspaceRef: 'workspace_b' }),
      idempotencyKey: 'shared-key',
    });

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.executionId).not.toBe(b.value.executionId);
  });

  it('rejects an unsupported contract version before touching the queue', async () => {
    const d = deps();
    const result = await submitExecution(d, {
      request: request({ contractVersion: 'runner.execution.v2' as never }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTRACT_VERSION_UNSUPPORTED');
    expect(d.queue.pending()).toHaveLength(0);
  });

  it('rejects a step that names no resolvable target', async () => {
    const d = deps();
    const result = await submitExecution(d, {
      request: request({
        test: { id: 'tc-1', name: 'x', steps: [{ id: 's1', type: 'click', target: {} }] },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('carries opaque external references into the stored record', async () => {
    const d = deps();
    const accepted = await submitExecution(d, {
      request: request({
        tenantRef: 'tenant_acme',
        externalTestCaseRef: 'XRAY-1741',
        requestId: 'req_9',
      }),
    });
    if (!accepted.ok) throw new Error('expected acceptance');

    const record = await d.store.get(accepted.value.executionId);
    if (!record.ok) return;

    expect(record.value.tenantRef).toBe('tenant_acme');
    expect(record.value.externalTestCaseRef).toBe('XRAY-1741');
    expect(record.value.requestId).toBe('req_9');
  });
});

describe('InMemoryExecutionStore', () => {
  it('reports a missing execution as EXECUTION_NOT_FOUND', async () => {
    const store = new InMemoryExecutionStore();
    const result = await store.get('run_missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EXECUTION_NOT_FOUND');
  });

  it('refuses to overwrite an existing execution', async () => {
    const d = deps();
    const accepted = await submitExecution(d, { request: request() });
    if (!accepted.ok) throw new Error('expected acceptance');

    const existing = await d.store.get(accepted.value.executionId);
    if (!existing.ok) return;

    const duplicate = await d.store.create(existing.value);
    expect(duplicate.ok).toBe(false);
  });
});
