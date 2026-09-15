import { describe, expect, it } from 'vitest';
import type { ElementCandidate, PageSnapshot } from '@runner/domain';
import { DefaultLocatorGenerator } from '../src/modules/locator/locator-generator.js';
import { extractPage } from '../src/modules/inspector/field-extractor.js';

const generator = new DefaultLocatorGenerator();

function candidate(overrides: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    runtimeId: 'rt_1',
    tag: 'input',
    attributes: {},
    visible: true,
    enabled: true,
    editable: true,
    interactable: true,
    ...overrides,
  };
}

function snapshotOf(elements: ElementCandidate[]): PageSnapshot {
  return {
    url: 'https://example.test/login',
    title: 'Sign in',
    capturedAt: '2026-01-01T00:00:00.000Z',
    elements,
    frames: [],
    pageMetadata: {},
  };
}

/** The two text inputs and the submit button of a typical login form. */
function loginPage(): PageSnapshot {
  return snapshotOf([
    candidate({
      runtimeId: 'rt_1',
      role: 'textbox',
      accessibleName: 'Username or email address',
      attributes: { id: 'login_field', name: 'login', type: 'text' },
    }),
    candidate({
      runtimeId: 'rt_2',
      role: 'textbox',
      accessibleName: 'Password',
      attributes: { id: 'password', name: 'password', type: 'password' },
    }),
    candidate({
      runtimeId: 'rt_3',
      role: 'button',
      accessibleName: 'Sign in',
      editable: false,
      attributes: { type: 'submit', value: 'Sign in' },
    }),
  ]);
}

describe('field extraction', () => {
  it('reports the fields a caller has to fill in', () => {
    const { fields } = extractPage(loginPage(), generator);

    expect(fields.map((field) => field.name)).toEqual([
      'Username or email address',
      'Password',
    ]);
    expect(fields.map((field) => field.type)).toEqual(['text', 'password']);
  });

  it('identifies the submit control separately from the fields', () => {
    const { fields, submit } = extractPage(loginPage(), generator);

    expect(submit?.name).toBe('Sign in');
    // The submit button takes no user value, so it must not appear as a field.
    expect(fields.some((field) => field.name === 'Sign in')).toBe(false);
  });

  it('gives every field a selector plus fallbacks, so a caller can heal one', () => {
    const [field] = extractPage(loginPage(), generator).fields;

    expect(field?.selector.score).toBeGreaterThan(0);
    expect(field?.fallbacks.length).toBeGreaterThan(0);
    // The primary must outrank what it falls back to.
    for (const fallback of field?.fallbacks ?? []) {
      expect(field!.selector.score).toBeGreaterThanOrEqual(fallback.score);
    }
  });

  it('reports the name attribute separately from the human-facing name', () => {
    const [field] = extractPage(loginPage(), generator).fields;

    expect(field?.name).toBe('Username or email address');
    expect(field?.fieldName).toBe('login');
  });

  it('excludes inputs that carry no user-supplied value', () => {
    const page = snapshotOf([
      candidate({ attributes: { type: 'hidden', name: 'csrf' }, visible: true }),
      candidate({ runtimeId: 'rt_2', attributes: { type: 'text', name: 'q' } }),
    ]);

    const { fields } = extractPage(page, generator);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.fieldName).toBe('q');
  });

  it('includes checkboxes, which a caller still has to decide about', () => {
    const page = snapshotOf([
      candidate({
        role: 'checkbox',
        accessibleName: 'Remember me',
        editable: false,
        attributes: { type: 'checkbox', name: 'remember' },
      }),
    ]);

    expect(extractPage(page, generator).fields[0]?.name).toBe('Remember me');
  });

  it('marks a field required only when the page says so', () => {
    const page = snapshotOf([
      candidate({ accessibleName: 'Email', attributes: { type: 'email', required: '' } }),
      candidate({ runtimeId: 'rt_2', accessibleName: 'Nickname', attributes: { type: 'text' } }),
    ]);

    const { fields } = extractPage(page, generator);
    expect(fields[0]?.required).toBe(true);
    expect(fields[1]?.required).toBe(false);
  });

  it('omits other controls unless they were asked for', () => {
    const page = snapshotOf([
      candidate({
        role: 'link',
        tag: 'a',
        accessibleName: 'Forgot password?',
        editable: false,
        attributes: { href: '/reset' },
      }),
    ]);

    expect(extractPage(page, generator).controls).toBeUndefined();
    expect(
      extractPage(page, generator, { includeNonInputControls: true }).controls,
    ).toHaveLength(1);
  });

  it('skips invisible elements, which no caller could fill in', () => {
    const page = snapshotOf([
      candidate({ accessibleName: 'Hidden field', visible: false, attributes: { type: 'text' } }),
    ]);

    expect(extractPage(page, generator).fields).toHaveLength(0);
  });
});
