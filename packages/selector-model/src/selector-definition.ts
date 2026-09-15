/**
 * The structured selector DSL (blueprint section 12).
 *
 * Registry entries and live selector edits are stored as data, never as
 * executable code. Two consequences follow, both deliberate:
 *
 *  - A user editing a selector in the live workspace cannot inject arbitrary
 *    JavaScript into the worker (blueprint rules 11 and 50).
 *  - The same definition can be translated to Playwright today and Selenium or
 *    Appium later, because nothing here is Playwright-specific.
 */
export type SelectorStrategy =
  | 'testId'
  | 'role'
  | 'label'
  | 'placeholder'
  | 'altText'
  | 'title'
  | 'text'
  | 'css'
  | 'xpath';

export interface TestIdSelector {
  readonly type: 'testId';
  readonly value: string;
}

export interface RoleSelector {
  readonly type: 'role';
  readonly role: string;
  /** Accessible name. Omitted when the role alone is unique. */
  readonly name?: string;
  readonly exact?: boolean;
}

export interface LabelSelector {
  readonly type: 'label';
  readonly value: string;
  readonly exact?: boolean;
}

export interface PlaceholderSelector {
  readonly type: 'placeholder';
  readonly value: string;
  readonly exact?: boolean;
}

export interface AltTextSelector {
  readonly type: 'altText';
  readonly value: string;
  readonly exact?: boolean;
}

export interface TitleSelector {
  readonly type: 'title';
  readonly value: string;
  readonly exact?: boolean;
}

export interface TextSelector {
  readonly type: 'text';
  readonly value: string;
  readonly exact?: boolean;
}

export interface CssSelector {
  readonly type: 'css';
  readonly value: string;
}

export interface XPathSelector {
  readonly type: 'xpath';
  readonly value: string;
}

export type SelectorDefinition =
  | TestIdSelector
  | RoleSelector
  | LabelSelector
  | PlaceholderSelector
  | AltTextSelector
  | TitleSelector
  | TextSelector
  | CssSelector
  | XPathSelector;

/**
 * Narrows a selector to a frame and/or an nth match.
 *
 * Kept separate from SelectorDefinition so the common case stays a flat,
 * human-readable object, and so `nth` — which is a stability smell — is always
 * visible as an explicit opt-in rather than hidden inside a CSS string.
 */
export interface ScopedSelector {
  readonly selector: SelectorDefinition;
  /** Chained selectors resolved relative to the previous match. */
  readonly within?: readonly SelectorDefinition[];
  readonly frameId?: string;
  readonly nth?: number;
}

/** Renders a selector as a short, stable string for logs and evidence. */
export function describeSelector(selector: SelectorDefinition): string {
  switch (selector.type) {
    case 'testId':
      return `testId=${selector.value}`;
    case 'role':
      return selector.name === undefined
        ? `role=${selector.role}`
        : `role=${selector.role}[name="${selector.name}"]`;
    case 'label':
      return `label=${selector.value}`;
    case 'placeholder':
      return `placeholder=${selector.value}`;
    case 'altText':
      return `altText=${selector.value}`;
    case 'title':
      return `title=${selector.value}`;
    case 'text':
      return `text=${selector.value}`;
    case 'css':
      return `css=${selector.value}`;
    case 'xpath':
      return `xpath=${selector.value}`;
  }
}

export function describeScopedSelector(scoped: ScopedSelector): string {
  const parts = [describeSelector(scoped.selector)];
  for (const step of scoped.within ?? []) parts.push(describeSelector(step));
  let description = parts.join(' >> ');
  if (scoped.nth !== undefined) description += ` >> nth=${scoped.nth}`;
  if (scoped.frameId !== undefined) description = `frame(${scoped.frameId}) ${description}`;
  return description;
}

/** Structural equality, used to deduplicate generated candidates. */
export function selectorsEqual(a: SelectorDefinition, b: SelectorDefinition): boolean {
  return describeSelector(a) === describeSelector(b) && a.type === b.type;
}
