import { describe, expect, it } from 'vitest';
import type { ElementCandidate, PageSnapshot } from '@runner/domain';
import { DefaultLocatorGenerator } from '../src/modules/locator/locator-generator.js';
import { projectRegistry } from '../src/modules/inspector/registry-projector.js';

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

function snapshotOf(elements: ElementCandidate[], title = 'Sign in'): PageSnapshot {
  return {
    url: 'https://example.test/login',
    title,
    capturedAt: '2026-01-01T00:00:00.000Z',
    elements,
    frames: [],
    pageMetadata: {},
  };
}

describe('registry projection', () => {
  it('generates a code-safe system name, never raw user text', () => {
    const page = snapshotOf([
      candidate({ accessibleName: 'Username or email address', attributes: { type: 'text' } }),
    ]);

    const [element] = projectRegistry(page, generator).elements;
    expect(element?.systemName).toBe('usernameOrEmailAddress');
    expect(element?.displayName).toBe('Username or email address');
  });

  it('keeps system names unique, so a Page Object cannot self-overwrite', () => {
    const page = snapshotOf([
      candidate({ runtimeId: 'rt_1', role: 'button', accessibleName: 'Edit', editable: false }),
      candidate({ runtimeId: 'rt_2', role: 'button', accessibleName: 'Edit', editable: false }),
      candidate({ runtimeId: 'rt_3', role: 'button', accessibleName: 'Edit', editable: false }),
    ]);

    const names = projectRegistry(page, generator).elements.map((e) => e.systemName);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe('edit');
  });

  it('ranks a primary selector above its own fallbacks', () => {
    const page = snapshotOf([
      candidate({
        role: 'textbox',
        accessibleName: 'Password',
        attributes: { id: 'password', name: 'password', type: 'password' },
      }),
    ]);

    const [element] = projectRegistry(page, generator).elements;
    expect(element?.fallbacks.length).toBeGreaterThan(0);
    for (const fallback of element?.fallbacks ?? []) {
      expect(element!.selector.score).toBeGreaterThanOrEqual(fallback.score);
    }
  });

  it('learns aliases from the page without duplicating the display name', () => {
    const page = snapshotOf([
      candidate({
        role: 'textbox',
        accessibleName: 'Email',
        attributes: { type: 'email', name: 'user_email', placeholder: 'you@example.com' },
      }),
    ]);

    const [element] = projectRegistry(page, generator).elements;
    expect(element?.aliases).toContain('you@example.com');
    expect(element?.aliases).toContain('user_email');
    expect(element?.aliases).not.toContain('Email');
  });

  /**
   * One look at a page is not grounds for acting unattended, so a first
   * sighting must stay below the auto-execute threshold no matter how strong
   * its selector is.
   */
  it('never reports first-sighting confidence at auto-execute level', () => {
    const page = snapshotOf([
      candidate({
        role: 'button',
        accessibleName: 'Sign in',
        editable: false,
        attributes: { 'data-testid': 'signin', type: 'submit' },
      }),
    ]);

    const [element] = projectRegistry(page, generator).elements;
    expect(element!.confidence).toBeGreaterThan(0);
    expect(element!.confidence).toBeLessThan(0.95);
  });

  it('classifies inputs, choices and buttons distinguishably', () => {
    const page = snapshotOf([
      candidate({ accessibleName: 'Email', attributes: { type: 'email' } }),
      candidate({
        runtimeId: 'rt_2',
        role: 'checkbox',
        accessibleName: 'Remember me',
        editable: false,
        attributes: { type: 'checkbox' },
      }),
      candidate({
        runtimeId: 'rt_3',
        role: 'button',
        accessibleName: 'Sign in',
        editable: false,
        attributes: { type: 'submit' },
      }),
    ]);

    const types = projectRegistry(page, generator).elements.map((e) => e.semanticType);
    expect(types).toEqual(['input', 'choice', 'button']);
  });

  it('describes the page itself, so generated code can name the object', () => {
    const { page } = projectRegistry(snapshotOf([], 'Sign in to GitHub'), generator);

    // toSystemName normalizes case per word, so "GitHub" becomes "Github":
    // the identifier is derived from the title, never a copy of it.
    expect(page.systemName).toBe('signInToGithub');
    expect(page.displayName).toBe('Sign in to GitHub');
    // The exact URL, not an invented glob that might match unrelated pages.
    expect(page.urlPattern).toBe('https://example.test/login');
  });

  /**
   * Sites append their own name after a separator. Keeping it would generate
   * `signInToGithubGithub`, and that identifier is what code generation emits.
   */
  it('drops a site-name suffix from the page identifier, not from its name', () => {
    for (const title of [
      'Sign in to GitHub · GitHub',
      'Sign in to GitHub | GitHub',
      'Sign in to GitHub – GitHub',
    ]) {
      const { page } = projectRegistry(snapshotOf([], title), generator);
      expect(page.systemName, title).toBe('signInToGithub');
      // The human-facing name keeps the page's own words untouched.
      expect(page.displayName, title).toBe(title);
    }
  });

  it('keeps stronger selectors more confident than weaker ones', () => {
    const page = snapshotOf([
      candidate({
        runtimeId: 'rt_1',
        role: 'button',
        accessibleName: 'Save',
        editable: false,
        attributes: { 'data-testid': 'save', type: 'button' },
      }),
      candidate({
        runtimeId: 'rt_2',
        role: 'button',
        accessibleName: '',
        editable: false,
        attributes: { class: 'btn primary', type: 'button' },
      }),
    ]);

    const [strong, weak] = projectRegistry(page, generator).elements;
    // A flat ceiling would report both identically, discarding the ranking
    // the locator engine just computed.
    expect(strong!.confidence).toBeGreaterThan(weak!.confidence);
  });

  it('reports field metadata a generator needs for a fill step', () => {
    const page = snapshotOf([
      candidate({
        role: 'textbox',
        accessibleName: 'Password',
        attributes: { type: 'password', name: 'password', required: '' },
      }),
    ]);

    const [element] = projectRegistry(page, generator).elements;
    expect(element?.fieldType).toBe('password');
    expect(element?.fieldName).toBe('password');
    expect(element?.required).toBe(true);
    expect(element?.editable).toBe(true);
  });
});
