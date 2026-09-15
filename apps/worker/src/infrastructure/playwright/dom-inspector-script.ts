/**
 * The DOM inspection routine, serialized into the page.
 *
 * Written as a single self-contained function because it is injected via
 * `page.evaluate` and cannot close over anything from the worker. It returns
 * plain JSON — never nodes, never HTML — which is what keeps the snapshot small
 * enough to log, store as evidence, and later hand a shortlist of to a model
 * (blueprint sections 10, 11 and 45).
 *
 * Everything here runs in the page's own context. It reads, and never writes,
 * so inspecting a page cannot change the behaviour under test.
 */

export interface RawCandidate {
  runtimeId: string;
  tag: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  attributes: Record<string, string>;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  interactable: boolean;
  bbox?: { x: number; y: number; width: number; height: number };
  context?: {
    parentText?: string;
    nearbyText?: string[];
    componentHint?: string;
    formHint?: string;
    landmark?: string;
    shadowHost?: string;
  };
  depth: number;
  domIndex: number;
}

export interface RawSnapshot {
  url: string;
  title: string;
  elements: RawCandidate[];
  domFingerprint: string;
  totalNodesScanned: number;
  /** Set when `rootSelector` matched nothing, so the caller can say which. */
  rootMissing?: boolean;
}

export interface InspectScriptOptions {
  interactableOnly: boolean;
  maxElements: number;
  /** CSS selector for the container to inspect inside; absent means the document. */
  rootSelector?: string;
}

/**
 * Returns the function body executed in the page.
 *
 * Kept as a function reference (not a string) so TypeScript still type-checks
 * it, while Playwright serializes it at call time.
 */
export function inspectPageScript(options: InspectScriptOptions): RawSnapshot {
  const INTERACTIVE_SELECTOR = [
    'button',
    'input',
    'textarea',
    'select',
    'a[href]',
    'summary',
    '[role=button]',
    '[role=link]',
    '[role=textbox]',
    '[role=checkbox]',
    '[role=radio]',
    '[role=combobox]',
    '[role=menuitem]',
    '[role=tab]',
    '[role=switch]',
    '[role=option]',
    '[contenteditable=""]',
    '[contenteditable=true]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const SIGNIFICANT = [
    'id',
    'name',
    'type',
    'value',
    'href',
    'placeholder',
    'title',
    'alt',
    'role',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-expanded',
    'aria-checked',
    'aria-selected',
    'aria-disabled',
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
    'class',
  ];

  const MAX_TEXT = 160;

  function clip(value: string | null | undefined): string | undefined {
    if (value === null || value === undefined) return undefined;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed;
  }

  function isVisible(element: Element): boolean {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number.parseFloat(style.opacity || '1') === 0) return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isEnabled(element: Element): boolean {
    if ('disabled' in element && (element as HTMLInputElement).disabled) return false;
    return element.getAttribute('aria-disabled') !== 'true';
  }

  function isEditable(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (tag === 'textarea') return isEnabled(element);
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      const nonText = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'];
      return !nonText.includes(type) && isEnabled(element);
    }
    return (element as HTMLElement).isContentEditable === true;
  }

  /**
   * A best-effort accessible name.
   *
   * Deliberately not a full accname implementation: this only has to be good
   * enough to *rank* candidates, and Playwright's own role engine does the
   * authoritative matching when the selector is finally evaluated.
   */
  function accessibleName(element: Element): string | undefined {
    const ariaLabel = clip(element.getAttribute('aria-label'));
    if (ariaLabel !== undefined) return ariaLabel;

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => clip(document.getElementById(id)?.textContent))
        .filter((name): name is string => name !== undefined);
      if (names.length > 0) return names.join(' ');
    }

    const id = element.getAttribute('id');
    if (id !== null && id.length > 0) {
      const escaped = window.CSS?.escape ? window.CSS.escape(id) : id;
      const label = clip(document.querySelector(`label[for="${escaped}"]`)?.textContent);
      if (label !== undefined) return label;
    }

    const wrappingLabel = element.closest('label');
    if (wrappingLabel !== null) {
      const label = clip(wrappingLabel.textContent);
      if (label !== undefined) return label;
    }

    const tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      if (type === 'submit' || type === 'button') {
        const value = clip(element.getAttribute('value'));
        if (value !== undefined) return value;
      }
      const placeholder = clip(element.getAttribute('placeholder'));
      if (placeholder !== undefined) return placeholder;
    }
    if (tag === 'img') {
      const alt = clip(element.getAttribute('alt'));
      if (alt !== undefined) return alt;
    }

    return clip(element.textContent);
  }

  function implicitRole(element: Element): string | undefined {
    const explicit = element.getAttribute('role');
    if (explicit !== null && explicit.length > 0) return explicit;

    const tag = element.tagName.toLowerCase();
    switch (tag) {
      case 'button':
        return 'button';
      case 'a':
        return element.hasAttribute('href') ? 'link' : undefined;
      case 'textarea':
        return 'textbox';
      case 'select':
        return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
      case 'summary':
        return 'button';
      case 'input': {
        const type = (element.getAttribute('type') ?? 'text').toLowerCase();
        const byType: Record<string, string> = {
          button: 'button',
          submit: 'button',
          reset: 'button',
          image: 'button',
          checkbox: 'checkbox',
          radio: 'radio',
          range: 'slider',
          number: 'spinbutton',
          search: 'searchbox',
          email: 'textbox',
          tel: 'textbox',
          url: 'textbox',
          text: 'textbox',
          password: 'textbox',
        };
        return byType[type];
      }
      default:
        return undefined;
    }
  }

  function depthOf(element: Element): number {
    let depth = 0;
    let current: Element | null = element.parentElement;
    while (current !== null) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function contextOf(element: Element): RawCandidate['context'] {
    const context: RawCandidate['context'] = {};

    const parentText = clip(element.parentElement?.textContent);
    if (parentText !== undefined) context.parentText = parentText;

    const form = element.closest('form');
    if (form !== null) {
      const hint = form.getAttribute('name') ?? form.getAttribute('id') ?? undefined;
      if (hint !== undefined && hint.length > 0) context.formHint = hint;
    }

    const component = element.closest('[data-component],[data-testid]');
    if (component !== null && component !== element) {
      const hint =
        component.getAttribute('data-component') ?? component.getAttribute('data-testid') ?? undefined;
      if (hint !== undefined && hint.length > 0) context.componentHint = hint;
    }

    const landmark = element.closest(
      'nav,main,header,footer,aside,dialog,[role=navigation],[role=main],[role=dialog],[role=banner]',
    );
    if (landmark !== null) {
      context.landmark = landmark.getAttribute('role') ?? landmark.tagName.toLowerCase();
    }

    // Nearby text disambiguates repeated controls, e.g. an "Edit" button in a
    // table row: the row's own text is what tells the rows apart.
    const nearby: string[] = [];
    const row = element.closest('tr,li,[role=row],[role=listitem]');
    if (row !== null) {
      const rowText = clip(row.textContent);
      if (rowText !== undefined) nearby.push(rowText);
    }
    const previous = clip(element.previousElementSibling?.textContent);
    if (previous !== undefined) nearby.push(previous);
    if (nearby.length > 0) context.nearbyText = nearby;

    return Object.keys(context).length > 0 ? context : undefined;
  }

  /*
   * The subtree to inspect.
   *
   * `rootMissing` is reported rather than thrown: this function is serialized
   * into the page, so an exception here surfaces as an opaque evaluate failure
   * with no selector in it. The adapter turns the flag into ELEMENT_NOT_FOUND
   * naming what was asked for.
   *
   * Note the root is resolved but never itself a candidate — it is the
   * container, and reporting it would put the panel's own wrapper into every
   * scoped scan, which is the thing a root is chosen to avoid.
   */
  const root =
    options.rootSelector === undefined || options.rootSelector.length === 0
      ? document
      : document.querySelector(options.rootSelector);

  if (root === null) {
    return {
      url: window.location.href,
      title: document.title,
      elements: [],
      domFingerprint: '0:rootMissing',
      totalNodesScanned: 0,
      rootMissing: true,
    };
  }

  const elements: RawCandidate[] = [];
  const all = Array.from(root.querySelectorAll<HTMLElement>('*'));
  const interactive = new Set<Element>(Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR)));

  let domIndex = 0;
  for (const element of all) {
    if (elements.length >= options.maxElements) break;

    domIndex += 1;
    const isInteractive = interactive.has(element);
    if (options.interactableOnly && !isInteractive) continue;

    const visible = isVisible(element);
    if (options.interactableOnly && !visible) continue;

    const attributes: Record<string, string> = {};
    for (const name of SIGNIFICANT) {
      const value = element.getAttribute(name);
      if (value !== null && value.length > 0) attributes[name] = value;
    }

    const enabled = isEnabled(element);
    const editable = isEditable(element);
    const rect = element.getBoundingClientRect();
    const role = implicitRole(element);
    const name = accessibleName(element);
    const text = clip(element.textContent);
    const context = contextOf(element);

    const candidate: RawCandidate = {
      runtimeId: `rt_${domIndex}`,
      tag: element.tagName.toLowerCase(),
      attributes,
      visible,
      enabled,
      editable,
      interactable: isInteractive && visible && enabled,
      depth: depthOf(element),
      domIndex,
    };

    if (role !== undefined) candidate.role = role;
    if (name !== undefined) candidate.accessibleName = name;
    if (text !== undefined) candidate.text = text;
    if (context !== undefined) candidate.context = context;
    if (rect.width > 0 && rect.height > 0) {
      candidate.bbox = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    elements.push(candidate);
  }

  // A cheap structural hash: enough to detect that the DOM changed after an
  // action, without storing or diffing the markup itself.
  const fingerprintSource = elements
    .map((element) => `${element.tag}:${element.role ?? ''}:${element.accessibleName ?? ''}`)
    .join('|');
  let hash = 0;
  for (let index = 0; index < fingerprintSource.length; index += 1) {
    hash = (hash << 5) - hash + fingerprintSource.charCodeAt(index);
    hash |= 0;
  }

  return {
    url: window.location.href,
    title: document.title,
    elements,
    domFingerprint: `${elements.length}:${hash.toString(16)}`,
    totalNodesScanned: all.length,
  };
}
