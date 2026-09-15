import { describe, expect, it } from 'vitest';
import {
  applicableStrategies,
  currentItem,
  describeCandidate,
  diffPageState,
  hasAnyChange,
  labelOf,
  lookupFromIntent,
  pendingItem,
  preferredSetupMethod,
  testIdOf,
  timelineStatus,
  type ElementCandidate,
  type ExecutionTimeline,
  type PageState,
} from '../src/index.js';

function candidate(overrides: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    runtimeId: 'rt_1',
    tag: 'button',
    attributes: {},
    visible: true,
    enabled: true,
    editable: false,
    interactable: true,
    ...overrides,
  };
}

describe('element candidate', () => {
  it('reads the first test id attribute in priority order', () => {
    expect(testIdOf(candidate({ attributes: { 'data-testid': 'a', 'data-cy': 'b' } }))).toBe('a');
    expect(testIdOf(candidate({ attributes: { 'data-qa': 'only' } }))).toBe('only');
    expect(testIdOf(candidate())).toBeUndefined();
  });

  it('ignores an empty test id rather than producing an empty selector', () => {
    expect(testIdOf(candidate({ attributes: { 'data-testid': '  ' } }))).toBeUndefined();
  });

  it('falls back through label sources', () => {
    expect(labelOf(candidate({ accessibleName: 'Login' }))).toBe('Login');
    expect(labelOf(candidate({ text: 'Click me' }))).toBe('Click me');
    expect(labelOf(candidate({ attributes: { placeholder: 'Email' } }))).toBe('Email');
    expect(labelOf(candidate({ tag: 'div' }))).toBe('div');
  });

  it('describes a candidate readably for evidence and logs', () => {
    expect(describeCandidate(candidate({ role: 'button', accessibleName: 'Login' }))).toBe(
      'button[button] "Login"',
    );
  });
});

describe('page state diffing', () => {
  const before: PageState = {
    url: 'https://app.test/orders',
    domFingerprint: '42:abc',
    frameCount: 1,
    hasOpenDialog: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
  };

  it('detects a navigation', () => {
    const change = diffPageState(before, { ...before, url: 'https://app.test/orders/1' });
    expect(change.urlChanged).toBe(true);
    expect(hasAnyChange(change)).toBe(true);
  });

  it('detects a DOM change', () => {
    const change = diffPageState(before, { ...before, domFingerprint: '50:def' });
    expect(change.domChanged).toBe(true);
  });

  it('reports no change when an action did nothing', () => {
    // The quiet failure mode this exists to catch: a click that "succeeded"
    // but left the page exactly as it was.
    expect(hasAnyChange(diffPageState(before, { ...before }))).toBe(false);
  });

  it('does not claim a DOM change when a fingerprint is missing', () => {
    const change = diffPageState(
      { ...before, domFingerprint: undefined },
      { ...before, domFingerprint: '50:def' },
    );
    expect(change.domChanged).toBe(false);
  });

  it('detects an opened dialog', () => {
    const change = diffPageState(before, { ...before, hasOpenDialog: true });
    expect(change.dialogOpened).toBe(true);
  });
});

describe('timeline', () => {
  const timeline = (statuses: string[]): ExecutionTimeline => ({
    executionId: 'run_1',
    items: statuses.map((status, index) => ({
      ...pendingItem(`s${index}`, 'click', `Step ${index}`),
      status: status as never,
    })),
  });

  it('reports FAILED when any step failed', () => {
    expect(timelineStatus(timeline(['PASSED', 'FAILED', 'SKIPPED']))).toBe('FAILED');
  });

  it('prioritizes WAITING_USER over a failure, because a human can still act', () => {
    expect(timelineStatus(timeline(['FAILED', 'WAITING_USER']))).toBe('WAITING_USER');
  });

  it('reports RUNNING while work remains', () => {
    expect(timelineStatus(timeline(['PASSED', 'PENDING']))).toBe('RUNNING');
  });

  it('reports PASSED only when every step finished successfully', () => {
    expect(timelineStatus(timeline(['PASSED', 'SKIPPED']))).toBe('PASSED');
  });

  it('finds the step a reviewer should look at', () => {
    expect(currentItem(timeline(['PASSED', 'RUNNING', 'PENDING']))?.stepId).toBe('s1');
    expect(currentItem(timeline(['PASSED', 'PASSED']))).toBeUndefined();
  });
});

describe('registry lookup', () => {
  it('builds a lookup from an intent without inventing fields', () => {
    const lookup = lookupFromIntent('workspace_1', { name: 'Login Button', role: 'button' });
    expect(lookup).toEqual({
      workspaceRef: 'workspace_1',
      name: 'Login Button',
      role: 'button',
    });
  });

  it('tries a stable id before any name-based strategy', () => {
    const strategies = applicableStrategies({ elementId: 'el_1', name: 'Login' });
    expect(strategies[0]).toBe('REGISTRY_ID');
    expect(strategies.indexOf('REGISTRY_DISPLAY_NAME')).toBeLessThan(
      strategies.indexOf('DOM_DISCOVERY'),
    );
  });

  it('always keeps DOM discovery as a last resort', () => {
    expect(applicableStrategies({})).toContain('DOM_DISCOVERY');
  });
});

describe('setup method priority', () => {
  it('prefers API setup over driving the UI', () => {
    expect(preferredSetupMethod(['UI_STEPS', 'API'])).toBe('API');
    expect(preferredSetupMethod(['UI_STEPS', 'FIXTURE'])).toBe('FIXTURE');
  });

  it('falls back to the UI when nothing faster exists', () => {
    expect(preferredSetupMethod(['UI_STEPS'])).toBe('UI_STEPS');
    expect(preferredSetupMethod([])).toBeUndefined();
  });
});
