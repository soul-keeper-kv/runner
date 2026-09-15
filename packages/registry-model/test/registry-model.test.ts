import { describe, expect, it } from 'vitest';
import {
  allNamesOf,
  canAutoCommitHealing,
  canTransition,
  computeElementConfidence,
  decideByConfidence,
  hasUserAuthoredName,
  isDecided,
  type ElementRegistryItem,
} from '../src/index.js';

const element: ElementRegistryItem = {
  id: 'el_1923',
  workspaceRef: 'workspace_checkout',
  systemName: 'createCustomerButton',
  displayName: 'Create Customer Button',
  displayNameSource: 'USER',
  aliases: [
    { value: 'Save Customer', source: 'USER', createdAt: '2026-01-01T00:00:00.000Z' },
    { value: 'Submit Customer', source: 'AI', createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  primarySelector: { type: 'testId', value: 'create-customer' },
  fallbackSelectors: [],
  userConfirmed: true,
  confidence: 0.98,
  selectorHistory: [],
  namingHistory: [],
  revision: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

describe('registry element', () => {
  it('exposes the display name ahead of aliases', () => {
    expect(allNamesOf(element)).toEqual([
      'Create Customer Button',
      'Save Customer',
      'Submit Customer',
    ]);
  });

  it('distinguishes a user-authored name from an AI-suggested one', () => {
    expect(hasUserAuthoredName(element)).toBe(true);
    expect(hasUserAuthoredName({ ...element, displayNameSource: 'AI' })).toBe(false);
  });
});

describe('modification lifecycle', () => {
  it('allows draft to be proposed and proposed to be decided', () => {
    expect(canTransition('DRAFT', 'PROPOSED')).toBe(true);
    expect(canTransition('PROPOSED', 'CONFIRMED')).toBe(true);
    expect(canTransition('PROPOSED', 'DRAFT')).toBe(true);
  });

  it('makes decided states final so history is never rewritten', () => {
    expect(canTransition('CONFIRMED', 'DRAFT')).toBe(false);
    expect(canTransition('REJECTED', 'CONFIRMED')).toBe(false);
    expect(isDecided('CONFIRMED')).toBe(true);
    expect(isDecided('DRAFT')).toBe(false);
  });
});

describe('confidence policy', () => {
  it('executes automatically only when confident', () => {
    expect(decideByConfidence(0.97, 'AUTO')).toBe('EXECUTE');
    expect(decideByConfidence(0.85, 'AUTO')).toBe('EXECUTE_WITH_WARNING');
    expect(decideByConfidence(0.5, 'AUTO')).toBe('WAITING_USER');
  });

  it('pauses on medium confidence in REVIEW mode', () => {
    expect(decideByConfidence(0.85, 'REVIEW')).toBe('WAITING_USER');
    expect(decideByConfidence(0.85, 'REVIEW', {
      autoExecuteThreshold: 0.95,
      reviewThreshold: 0.7,
      pauseOnMediumConfidence: false,
      autoHealThreshold: 0.97,
    })).toBe('EXECUTE_WITH_WARNING');
  });

  it('never acts on its own in INTERACTIVE mode', () => {
    expect(decideByConfidence(0.99, 'INTERACTIVE')).toBe('WAITING_USER');
  });

  it('auto-commits healing only in AUTO mode above the heal threshold', () => {
    expect(canAutoCommitHealing(0.98, 'AUTO')).toBe(true);
    expect(canAutoCommitHealing(0.98, 'REVIEW')).toBe(false);
    expect(canAutoCommitHealing(0.9, 'AUTO')).toBe(false);
  });
});

describe('computeElementConfidence', () => {
  it('treats a user confirmation as near-certainty even for a weak selector', () => {
    const confidence = computeElementConfidence({ selectorScore: 40, userConfirmed: true });
    expect(confidence).toBeGreaterThanOrEqual(0.96);
  });

  it('does not read a single success as certainty', () => {
    const confidence = computeElementConfidence({
      selectorScore: 100,
      userConfirmed: false,
      successCount: 1,
      failureCount: 0,
    });
    expect(confidence).toBeLessThan(0.95);
  });

  it('rewards a long successful history', () => {
    const fresh = computeElementConfidence({ selectorScore: 95, userConfirmed: false });
    const proven = computeElementConfidence({
      selectorScore: 95,
      userConfirmed: false,
      successCount: 40,
      failureCount: 0,
    });
    expect(proven).toBeGreaterThan(fresh);
  });

  it('penalizes a flaky history', () => {
    const stable = computeElementConfidence({
      selectorScore: 95,
      userConfirmed: false,
      successCount: 20,
      failureCount: 0,
    });
    const flaky = computeElementConfidence({
      selectorScore: 95,
      userConfirmed: false,
      successCount: 10,
      failureCount: 10,
    });
    expect(flaky).toBeLessThan(stable);
  });
});
