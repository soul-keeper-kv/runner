import type { Frame, Locator, Page } from 'playwright';
import type { ScopedSelector, SelectorDefinition } from '@runner/selector-model';
import { describeSelector, validateScopedSelector } from '@runner/selector-model';
import { RunnerErrors, err, ok, type Result } from '@runner/shared';

/**
 * Translates the structured selector DSL into Playwright locators.
 *
 * This is the single point where a stored selector becomes an executable
 * locator, and it is the reason the selector editor cannot be an
 * arbitrary-code-execution path (blueprint rules 11 and 50): the input is a
 * tagged union, every branch maps to a typed Playwright call, and there is no
 * path from user text to `eval`, `page.evaluate`, or a selector-engine
 * expression. A malformed or hostile value fails validation before it gets
 * here, and an unknown `type` cannot exist because the union is exhaustive.
 *
 * It is also the seam a Selenium or Appium adapter would reimplement — nothing
 * above this file knows Playwright exists.
 */
export function toLocator(root: Page | Frame, scoped: ScopedSelector): Result<Locator> {
  const validation = validateScopedSelector(scoped);
  if (!validation.valid) {
    return err(
      RunnerErrors.selectorInvalid(
        describeSelector(scoped.selector),
        validation.issues.map((issue) => `${issue.path}: ${issue.reason}`).join('; '),
      ),
    );
  }

  let locator = applySelector(root, scoped.selector);

  // Chained steps narrow the search relative to the previous match, which is
  // how a component-scoped element stays unambiguous on a busy page.
  for (const step of scoped.within ?? []) {
    locator = applySelectorToLocator(locator, step);
  }

  if (scoped.nth !== undefined) {
    locator = locator.nth(scoped.nth);
  }

  return ok(locator);
}

function applySelector(root: Page | Frame, selector: SelectorDefinition): Locator {
  switch (selector.type) {
    case 'testId':
      return root.getByTestId(selector.value);
    case 'role':
      return root.getByRole(selector.role as Parameters<Page['getByRole']>[0], {
        ...(selector.name === undefined ? {} : { name: selector.name }),
        ...(selector.exact === undefined ? {} : { exact: selector.exact }),
      });
    case 'label':
      return root.getByLabel(selector.value, exactOption(selector.exact));
    case 'placeholder':
      return root.getByPlaceholder(selector.value, exactOption(selector.exact));
    case 'altText':
      return root.getByAltText(selector.value, exactOption(selector.exact));
    case 'title':
      return root.getByTitle(selector.value, exactOption(selector.exact));
    case 'text':
      return root.getByText(selector.value, exactOption(selector.exact));
    case 'css':
      return root.locator(selector.value);
    case 'xpath':
      // Prefixed explicitly so a leading-slash string is never mistaken for CSS.
      return root.locator(`xpath=${selector.value}`);
  }
}

function applySelectorToLocator(parent: Locator, selector: SelectorDefinition): Locator {
  switch (selector.type) {
    case 'testId':
      return parent.getByTestId(selector.value);
    case 'role':
      return parent.getByRole(selector.role as Parameters<Locator['getByRole']>[0], {
        ...(selector.name === undefined ? {} : { name: selector.name }),
        ...(selector.exact === undefined ? {} : { exact: selector.exact }),
      });
    case 'label':
      return parent.getByLabel(selector.value, exactOption(selector.exact));
    case 'placeholder':
      return parent.getByPlaceholder(selector.value, exactOption(selector.exact));
    case 'altText':
      return parent.getByAltText(selector.value, exactOption(selector.exact));
    case 'title':
      return parent.getByTitle(selector.value, exactOption(selector.exact));
    case 'text':
      return parent.getByText(selector.value, exactOption(selector.exact));
    case 'css':
      return parent.locator(selector.value);
    case 'xpath':
      return parent.locator(`xpath=${selector.value}`);
  }
}

function exactOption(exact: boolean | undefined): { exact?: boolean } {
  return exact === undefined ? {} : { exact };
}
