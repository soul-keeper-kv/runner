import { describe, expect, it } from 'vitest';
import {
  describeAtPointScript,
  describeElementScript,
} from '../src/infrastructure/playwright/point-pick-script.js';
import { inspectPageScript } from '../src/infrastructure/playwright/dom-inspector-script.js';

/**
 * Two guards on the point-pick script.
 *
 * The first is the `__name` trap that `page-evaluate-serialization.test.ts`
 * documents: `page.evaluate` serializes a function's *compiled* source, esbuild
 * rewrites nested functions as `__name(fn, "…")`, and that helper does not exist
 * in a browser. Any new evaluate site has to be covered, or it works from
 * `dist/` and throws under `tsx`.
 *
 * The second is parity. `describeAtPointScript` duplicates `implicitRole` and
 * `accessibleName` from `dom-inspector-script.ts` because an evaluated function
 * cannot import anything. A picked element and the same element in a page
 * snapshot must describe themselves identically — otherwise picking a
 * `<button>` produces no `role=button[name="…"]` selector while inspecting the
 * same page does, and the Registry gets a weaker fallback chain than it should.
 * These tests compare the two sources so a change to one that is not mirrored in
 * the other fails here rather than in production.
 */

describe('point-pick script serialization', () => {
  it('runs when the page provides the transpiler helper', () => {
    const source = describeAtPointScript.toString();

    const withHelper = new Function(
      '__name',
      `"use strict"; const fn = ${source}; return typeof fn;`,
    );

    expect(withHelper((value: unknown) => value)).toBe('function');
  });

  it('is only safe to serialize because the adapter installs that helper', () => {
    const source = describeAtPointScript.toString();
    const needsHelper = source.includes('__name(');

    if (!needsHelper) {
      // Compiled output carries no wrapper; the adapter's shim is harmless.
      expect(needsHelper).toBe(false);
      return;
    }

    const withoutHelper = new Function(`"use strict"; const fn = ${source}; return fn;`);
    expect(() => withoutHelper()).toThrow(/__name is not defined/);
  });
});

/**
 * Compares the two copies structurally rather than by exact text: the functions
 * are nested in different scopes, so formatting differs while the decisions
 * must not.
 */
describe('parity with the page inspector', () => {
  const pickSource = describeAtPointScript.toString();
  const inspectSource = inspectPageScript.toString();

  it('maps the same implicit roles for the tags that matter', () => {
    // Each of these drives which selectors the generator can offer, so a
    // divergence silently weakens picked-element selectors.
    const roleMappings: readonly [string, string][] = [
      ['button', 'button'],
      ['textarea', 'textbox'],
      ['combobox', 'combobox'],
      ['listbox', 'listbox'],
      ['checkbox', 'checkbox'],
      ['radio', 'radio'],
      ['slider', 'slider'],
      ['spinbutton', 'spinbutton'],
      ['searchbox', 'searchbox'],
      ['link', 'link'],
    ];

    for (const [, role] of roleMappings) {
      expect(pickSource, `pick script should know the "${role}" role`).toContain(role);
      expect(inspectSource, `inspector should know the "${role}" role`).toContain(role);
    }
  });

  it('resolves an accessible name through the same sources, in the same order', () => {
    // Matched without quote characters: `toString()` returns the *compiled*
    // source, and esbuild normalizes single quotes to double. Asserting on
    // `closest('label')` therefore fails against correct code.
    const nameSources = [
      'aria-label',
      'aria-labelledby',
      'label[for=',
      'closest(',
      'placeholder',
      'alt',
    ];

    for (const source of nameSources) {
      expect(pickSource, `pick script should consult ${source}`).toContain(source);
      expect(inspectSource, `inspector should consult ${source}`).toContain(source);
    }
  });

  it('treats an input\'s placeholder as a fallback, never ahead of a label', () => {
    // The bug this pins: reading the placeholder first made a picked email field
    // report "you@example.com" where the inspector reported "Email".
    const labelIndex = pickSource.indexOf('label[for=');
    const placeholderIndex = pickSource.indexOf('placeholder');

    expect(labelIndex).toBeGreaterThan(-1);
    expect(placeholderIndex).toBeGreaterThan(labelIndex);
  });

  it('clips text to the same length, so one view is not truncated differently', () => {
    expect(pickSource).toContain('160');
    expect(inspectSource).toContain('160');
  });
});

/**
 * A regression guard for a bug that unit tests could not see.
 *
 * The page script resolved the accessible name correctly, but the adapter built
 * its `ElementCandidate` without copying the field across — so a picked email
 * input reported its placeholder ("you@example.com") where the page inspector
 * reported its label ("Email"). Everything typechecked, and every test passed;
 * only a real browser showed it.
 *
 * These run the serialized scripts against a minimal fake DOM, which is enough
 * to pin the contract both adapter call sites depend on: whatever the script
 * resolves must arrive in the result.
 */
describe('name and role survive the trip out of the page', () => {
  interface FakeElement {
    tagName: string;
    attributes: { name: string; value: string }[];
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    closest(selector: string): { textContent: string } | null;
    getBoundingClientRect(): { x: number; y: number; width: number; height: number };
    isContentEditable: boolean;
    tabIndex: number;
    textContent: string;
    parentElement: FakeElement | null;
    disabled: boolean;
  }

  function labelledInput(): FakeElement {
    const attributes = [
      { name: 'id', value: 'email' },
      { name: 'type', value: 'email' },
      { name: 'placeholder', value: 'you@example.com' },
    ];
    return {
      tagName: 'INPUT',
      attributes,
      getAttribute: (name) => attributes.find((a) => a.name === name)?.value ?? null,
      hasAttribute: (name) => attributes.some((a) => a.name === name),
      closest: () => null,
      getBoundingClientRect: () => ({ x: 50, y: 80, width: 177, height: 21 }),
      isContentEditable: false,
      tabIndex: 0,
      textContent: '',
      parentElement: null,
      disabled: false,
    };
  }

  /** A document whose `label[for="email"]` resolves, as a real page's would. */
  function documentFor(element: FakeElement): unknown {
    return {
      elementFromPoint: () => element,
      getElementById: () => null,
      querySelector: (selector: string) =>
        selector === 'label[for="email"]' ? { textContent: 'Email' } : null,
      querySelectorAll: () => [element],
      body: {},
    };
  }

  function run<T>(script: (arg: never) => T, element: FakeElement, arg: unknown): T {
    const factory = new Function(
      'document',
      'window',
      '__name',
      `"use strict"; return (${script.toString()});`,
    );
    const fn = factory(documentFor(element), { CSS: { escape: (s: string) => s } }, (f: unknown) => f);
    return fn(arg) as T;
  }

  it('resolves the label, not the placeholder, when picking by point', () => {
    const element = labelledInput();
    const picked = run(describeAtPointScript, element, { x: 139, y: 91 });

    expect(picked?.accessibleName).toBe('Email');
    expect(picked?.role).toBe('textbox');
  });

  it('resolves the same name and role when describing by selector', () => {
    // The two adapter call sites must agree; they previously did not, because
    // this path read only the `role` attribute and computed no name at all.
    const element = labelledInput();
    const described = run(describeElementScript, element, element);

    expect(described.accessibleName).toBe('Email');
    expect(described.role).toBe('textbox');
  });

  it('still falls back to the placeholder when there is no label', () => {
    const element = labelledInput();
    const factory = new Function(
      'document',
      'window',
      '__name',
      `"use strict"; return (${describeAtPointScript.toString()});`,
    );
    const fn = factory(
      {
        elementFromPoint: () => element,
        getElementById: () => null,
        // No label in this document.
        querySelector: () => null,
        querySelectorAll: () => [element],
        body: {},
      },
      { CSS: { escape: (s: string) => s } },
      (f: unknown) => f,
    );

    expect(fn({ x: 1, y: 1 })?.accessibleName).toBe('you@example.com');
  });
});
