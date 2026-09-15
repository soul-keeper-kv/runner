import { describe, expect, it } from 'vitest';
import {
  LIVE_COMMAND_TYPES,
  canAcceptCommands,
  capabilityForCommand,
  isLiveCommandType,
  isLiveEventType,
  isLiveSessionAlive,
  type LiveSession,
} from '../src/index.js';

const session: LiveSession = {
  id: 'ls_1',
  workspaceRef: 'workspace_1',
  browserSessionId: 'bs_1',
  executionState: 'IDLE',
  revision: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('command routing', () => {
  it('routes every published command to a capability', () => {
    // A command with no owning capability could never be dispatched, so this
    // guards against adding one to the enum and forgetting the namespace map.
    for (const type of LIVE_COMMAND_TYPES) {
      expect(capabilityForCommand(type)).toBeDefined();
    }
  });

  it('routes by namespace', () => {
    expect(capabilityForCommand('browser.navigate')).toBe('browser');
    expect(capabilityForCommand('selector.preview')).toBe('selector');
    expect(capabilityForCommand('registry.confirm')).toBe('registry');
    // Both step.* and session.* belong to execution control.
    expect(capabilityForCommand('step.execute')).toBe('execution');
    expect(capabilityForCommand('session.pause')).toBe('execution');
  });

  it('recognizes published command and event types', () => {
    expect(isLiveCommandType('selector.preview')).toBe(true);
    expect(isLiveCommandType('browser.eval')).toBe(false);
    expect(isLiveEventType('page.navigated')).toBe(true);
    expect(isLiveEventType('page.exploded')).toBe(false);
  });
});

describe('session state', () => {
  it('treats every state but CLOSED as alive', () => {
    expect(isLiveSessionAlive(session)).toBe(true);
    expect(isLiveSessionAlive({ ...session, executionState: 'FAILED' })).toBe(true);
    expect(isLiveSessionAlive({ ...session, executionState: 'CLOSED' })).toBe(false);
  });

  it('refuses commands while a step is running', () => {
    // Accepting an edit mid-step would race the executing action.
    expect(canAcceptCommands({ ...session, executionState: 'RUNNING' })).toBe(false);
    expect(canAcceptCommands({ ...session, executionState: 'PAUSED' })).toBe(true);
    expect(canAcceptCommands({ ...session, executionState: 'WAITING_USER' })).toBe(true);
  });

  it('refuses commands on a closed session', () => {
    expect(canAcceptCommands({ ...session, executionState: 'CLOSED' })).toBe(false);
  });
});
