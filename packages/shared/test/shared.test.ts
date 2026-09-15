import { describe, expect, it } from 'vitest';
import {
  RunnerError,
  RunnerErrors,
  collectResults,
  err,
  flatMapResult,
  fixedClock,
  isRunnerErrorCode,
  kindOfErrorCode,
  mapResult,
  newExecutionId,
  ok,
  toSystemName,
  unwrapOr,
} from '../src/index.js';

describe('Result', () => {
  it('maps only success values', () => {
    expect(mapResult(ok(2), (n) => n * 3)).toEqual(ok(6));
    const failure = err(RunnerErrors.internal('boom'));
    expect(mapResult(failure, (n: number) => n * 3)).toBe(failure);
  });

  it('short-circuits chained steps on failure', () => {
    const failure = err(RunnerErrors.internal('boom'));
    expect(flatMapResult(failure, () => ok('never'))).toBe(failure);
    expect(flatMapResult(ok(1), (n) => ok(n + 1))).toEqual(ok(2));
  });

  it('collects results and stops at the first failure', () => {
    expect(collectResults([ok(1), ok(2)])).toEqual(ok([1, 2]));
    const failure = err(RunnerErrors.internal('boom'));
    expect(collectResults([ok(1), failure, ok(3)])).toBe(failure);
  });

  it('falls back for failures', () => {
    expect(unwrapOr(err(RunnerErrors.internal('boom')), 42)).toBe(42);
  });
});

describe('RunnerError', () => {
  it('derives kind from code so setup failures are not reported as test failures', () => {
    expect(kindOfErrorCode('PRECONDITION_FAILED')).toBe('PRECONDITION_FAILURE');
    expect(kindOfErrorCode('ASSERTION_FAILED')).toBe('TEST_FAILURE');
  });

  it('serializes without leaking a stack trace', () => {
    const error = RunnerErrors.selectorNotUnique("css=.btn", 3);
    const json = error.toJSON();
    expect(json.code).toBe('SELECTOR_NOT_UNIQUE');
    expect(json.details).toMatchObject({ matchCount: 3 });
    expect(JSON.stringify(json)).not.toContain('at ');
  });

  it('normalizes unknown thrown values', () => {
    const error = RunnerError.from(new TypeError('bad'));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toContain('bad');
  });

  it('recognizes its own codes', () => {
    expect(isRunnerErrorCode('ELEMENT_NOT_FOUND')).toBe(true);
    expect(isRunnerErrorCode('NOT_A_CODE')).toBe(false);
  });
});

describe('identifiers', () => {
  it('prefixes generated ids', () => {
    expect(newExecutionId()).toMatch(/^run_[0-9a-f]{16}$/);
  });

  it('normalizes display names into code-safe system names', () => {
    expect(toSystemName('Create Customer Button')).toBe('createCustomerButton');
    expect(toSystemName('  Ô Nhập Tên  ')).toBe('oNhapTen');
    expect(toSystemName('2FA Code Field')).toBe('el2faCodeField');
    expect(toSystemName('!!!')).toBe('unnamedElement');
  });
});

describe('clock', () => {
  it('advances deterministically', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    clock.advance(1500);
    expect(clock.nowIso()).toBe('2026-01-01T00:00:01.500Z');
  });
});
