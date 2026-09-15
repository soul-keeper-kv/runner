import { describe, expect, it } from 'vitest';
import {
  EXECUTION_CONTRACT_VERSION,
  TEST_ACTION_TYPES,
  TEST_IR_VERSION,
  actionRequiresTarget,
  actionRequiresValue,
  describeIntent,
  isTerminalStatus,
  isTestActionType,
} from '../src/index.js';

describe('contract versions', () => {
  it('pins the version strings callers depend on', () => {
    // These strings are part of the published contract. A change here is a
    // breaking change for every integrating service.
    expect(EXECUTION_CONTRACT_VERSION).toBe('runner.execution.v1');
    expect(TEST_IR_VERSION).toBe('test-ir.v1');
  });
});

describe('action types', () => {
  it('recognizes every published action type', () => {
    for (const type of TEST_ACTION_TYPES) {
      expect(isTestActionType(type)).toBe(true);
    }
  });

  it('rejects an unknown type', () => {
    expect(isTestActionType('teleport')).toBe(false);
    expect(isTestActionType(undefined)).toBe(false);
  });

  it('knows which actions need a target', () => {
    expect(actionRequiresTarget('click')).toBe(true);
    expect(actionRequiresTarget('assert')).toBe(true);
    expect(actionRequiresTarget('goto')).toBe(false);
    expect(actionRequiresTarget('wait')).toBe(false);
  });

  it('knows which actions need a value', () => {
    expect(actionRequiresValue('goto')).toBe(true);
    expect(actionRequiresValue('fill')).toBe(true);
    expect(actionRequiresValue('select')).toBe(true);
    expect(actionRequiresValue('press')).toBe(true);
    expect(actionRequiresValue('click')).toBe(false);
  });
});

describe('execution status', () => {
  it('treats only finished states as terminal', () => {
    expect(isTerminalStatus('PASSED')).toBe(true);
    expect(isTerminalStatus('FAILED')).toBe(true);
    expect(isTerminalStatus('CANCELLED')).toBe(true);
  });

  it('does not treat a paused run as finished, so pollers keep waiting', () => {
    expect(isTerminalStatus('QUEUED')).toBe(false);
    expect(isTerminalStatus('RUNNING')).toBe(false);
    expect(isTerminalStatus('WAITING_USER')).toBe(false);
  });
});

describe('describeIntent', () => {
  it('prefers the strongest available reference', () => {
    expect(describeIntent({ elementId: 'el_1', name: 'Login' })).toBe('elementId=el_1');
    expect(describeIntent({ name: 'Login', description: 'Signs in' })).toBe('name="Login"');
    expect(describeIntent({ description: 'Signs in' })).toBe('description="Signs in"');
    expect(describeIntent({ role: 'button' })).toBe('role=button');
  });

  it('describes an absent or empty intent without throwing', () => {
    expect(describeIntent(undefined)).toBe('<no target>');
    expect(describeIntent({})).toBe('<empty intent>');
  });
});
