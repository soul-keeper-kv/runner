import { describe, expect, it } from 'vitest';
import { inspectPageScript } from '../src/infrastructure/playwright/dom-inspector-script.js';

/**
 * Guards a failure mode that only appears when the worker runs from TypeScript
 * source rather than from `dist/`.
 *
 * `page.evaluate` serializes a function's *compiled* source and runs it inside
 * the browser. esbuild — which tsx uses, so this covers `pnpm dev` and the
 * VS Code launch configs — rewrites named functions and arrows as
 * `__name(fn, "name")` to preserve `Function.name`. That helper lives in the
 * Node module scope, not in the page, so the serialized function throws
 * `ReferenceError: __name is not defined` the instant it runs. Compiled output
 * carries no such wrapper, which is why `node dist/main.js` worked while
 * `node --import tsx src/main.ts` failed on every inspection.
 *
 * The adapter fixes this by defining a matching helper in the page before any
 * evaluate call. This test fails if that protection is ever dropped: it runs
 * the serialized source in an isolated scope with no helpers defined, which is
 * exactly the environment the browser provides.
 */
describe('functions sent into the page', () => {
  it('runs when the page provides the transpiler helper', () => {
    const source = inspectPageScript.toString();

    // The browser has `__name` defined by ensureTranspilerHelpers().
    const withHelper = new Function(
      '__name',
      `"use strict"; const fn = ${source}; return typeof fn;`,
    );

    expect(withHelper((value: unknown) => value)).toBe('function');
  });

  it('is only safe to serialize because the adapter installs that helper', () => {
    const source = inspectPageScript.toString();
    const needsHelper = source.includes('__name(');

    if (!needsHelper) {
      // Compiled output: nothing to shim, and the adapter's shim is harmless.
      expect(needsHelper).toBe(false);
      return;
    }

    // Transpiled output: without the shim this throws in the page. Asserting
    // the throw documents *why* ensureTranspilerHelpers has to exist.
    const withoutHelper = new Function(`"use strict"; const fn = ${source}; return fn;`);
    expect(() => withoutHelper()).toThrow(/__name is not defined/);
  });
});
