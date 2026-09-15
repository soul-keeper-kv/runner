import { describe, expect, it } from 'vitest';
import type { ExecutionRequestV1 } from '@runner/test-ir-model';
import { mapAction, mapExecutionRequest } from '../src/mappers/inbound-test-action-mapper.js';

function requestWith(overrides: Partial<ExecutionRequestV1> = {}): ExecutionRequestV1 {
  return {
    contractVersion: 'runner.execution.v1',
    irVersion: 'test-ir.v1',
    workspaceRef: 'workspace_checkout',
    test: {
      id: 'ir-1',
      name: 'Login flow',
      steps: [
        { id: 'step-1', type: 'goto', value: '/login' },
        { id: 'step-2', type: 'click', target: { name: 'Login Button' } },
      ],
    },
    ...overrides,
  } as ExecutionRequestV1;
}

describe('mapExecutionRequest', () => {
  it('maps a valid request into an execution plan', () => {
    const result = mapExecutionRequest({ request: requestWith(), executionId: 'run_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.executionId).toBe('run_1');
    expect(result.value.mode).toBe('AUTO');
    expect(result.value.actions).toHaveLength(2);
    expect(result.value.options.headless).toBe(true);
  });

  it('rejects an unsupported contract version with a clear error', () => {
    const request = requestWith({ contractVersion: 'runner.execution.v2' as never });
    const result = mapExecutionRequest({ request, executionId: 'run_1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTRACT_VERSION_UNSUPPORTED');
    expect(result.error.details).toMatchObject({ received: 'runner.execution.v2' });
  });

  it('rejects an unsupported IR version', () => {
    const request = requestWith({ irVersion: 'test-ir.v9' });
    const result = mapExecutionRequest({ request, executionId: 'run_1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONTRACT_VERSION_UNSUPPORTED');
  });

  it('requires a workspace reference', () => {
    const request = requestWith({ workspaceRef: '  ' });
    const result = mapExecutionRequest({ request, executionId: 'run_1' });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty step list', () => {
    const request = requestWith({ test: { id: 'ir-1', name: 'Empty', steps: [] } });
    const result = mapExecutionRequest({ request, executionId: 'run_1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects duplicate step ids, which would corrupt the timeline', () => {
    const request = requestWith({
      test: {
        id: 'ir-1',
        name: 'Duplicates',
        steps: [
          { id: 'step-1', type: 'goto', value: '/a' },
          { id: 'step-1', type: 'goto', value: '/b' },
        ],
      },
    });
    const result = mapExecutionRequest({ request, executionId: 'run_1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Duplicate step id');
  });

  it('applies caller options over the defaults', () => {
    const request = requestWith({
      mode: 'REVIEW',
      options: { headless: false, stopOnFailure: false, defaultTimeoutMs: 5000 },
    });
    const result = mapExecutionRequest({ request, executionId: 'run_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe('REVIEW');
    expect(result.value.options.headless).toBe(false);
    expect(result.value.options.stopOnFailure).toBe(false);
    expect(result.value.options.defaultTimeoutMs).toBe(5000);
  });

  it('carries opaque external references through untouched', () => {
    const request = requestWith({
      tenantRef: 'tenant_acme',
      externalTestCaseRef: 'XRAY-1741',
      requestId: 'req_f8b27c',
    });
    const result = mapExecutionRequest({ request, executionId: 'run_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantRef).toBe('tenant_acme');
    expect(result.value.externalTestCaseRef).toBe('XRAY-1741');
    expect(result.value.requestId).toBe('req_f8b27c');
  });
});

describe('mapAction', () => {
  it('requires a target for element-bound actions', () => {
    const result = mapAction({ id: 's1', type: 'click' }, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('requires a target');
  });

  it('does not require a target for goto', () => {
    const result = mapAction({ id: 's1', type: 'goto', value: '/home' }, 0);
    expect(result.ok).toBe(true);
  });

  it('requires a value for fill', () => {
    const result = mapAction({ id: 's1', type: 'fill', target: { name: 'Email' } }, 0);
    expect(result.ok).toBe(false);
  });

  it('requires an assertion for assert steps', () => {
    const result = mapAction({ id: 's1', type: 'assert', target: { name: 'Title' } }, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('assertion');
  });

  it('rejects an unknown action type', () => {
    const result = mapAction({ id: 's1', type: 'teleport' as never }, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Unknown action type');
  });

  it('rejects a target that names nothing resolvable', () => {
    const result = mapAction({ id: 's1', type: 'click', target: { name: '   ' } }, 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('at least one of');
  });

  it('normalizes whitespace and role casing so equivalent intents match', () => {
    const result = mapAction(
      { id: 's1', type: 'click', target: { name: '  Login Button  ', role: 'BUTTON' } },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target?.name).toBe('Login Button');
    expect(result.value.target?.role).toBe('button');
  });

  it('derives a readable label when the caller supplies none', () => {
    const result = mapAction({ id: 's1', type: 'click', target: { name: 'Login Button' } }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe('click name="Login Button"');
  });

  it('keeps a caller-supplied label', () => {
    const result = mapAction(
      { id: 's1', type: 'click', label: 'Sign in as manager', target: { name: 'Login' } },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe('Sign in as manager');
  });

  it('maps preconditions and defaults them to an empty list', () => {
    const withPreconditions = mapAction(
      {
        id: 's1',
        type: 'click',
        target: { name: 'Approve Button' },
        preconditions: [
          { type: 'authenticated', profile: 'MANAGER' },
          { type: 'entityState', entity: 'ORDER', state: 'SUBMITTED' },
        ],
      },
      0,
    );
    expect(withPreconditions.ok).toBe(true);
    if (!withPreconditions.ok) return;
    expect(withPreconditions.value.preconditions).toHaveLength(2);
    expect(withPreconditions.value.preconditions[0]).toMatchObject({
      type: 'authenticated',
      profile: 'MANAGER',
    });

    const without = mapAction({ id: 's2', type: 'click', target: { name: 'X' } }, 1);
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.value.preconditions).toEqual([]);
  });

  it('rejects a malformed precondition rather than silently dropping it', () => {
    const result = mapAction(
      {
        id: 's1',
        type: 'click',
        target: { name: 'Approve' },
        preconditions: [null as never],
      },
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Precondition at index 0');
  });
});
