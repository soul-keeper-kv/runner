/**
 * The point-pick routine, serialized into the page.
 *
 * Like `inspectPageScript`, this is one self-contained function: `page.evaluate`
 * serializes a single function and it cannot close over anything in the worker,
 * so the helpers it needs are nested inside it.
 *
 * That forces a deliberate duplication. `implicitRole` and `accessibleName`
 * below must agree with the versions in `dom-inspector-script.ts`, because a
 * picked element and the same element in a page snapshot have to describe
 * themselves identically — otherwise picking a `<button>` yields no
 * `role=button[name="Login"]` selector while inspecting the same page does, and
 * the two views of one element disagree. `point-pick-parity.test.ts` pins that
 * agreement so the copies cannot drift apart unnoticed.
 */

export interface PointPickResult {
  tag: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  attributes: Record<string, string>;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  bbox: { x: number; y: number; width: number; height: number };
  domIndex: number;
}

export function describeAtPointScript(point: { x: number; y: number }): PointPickResult | null {
  const MAX_TEXT = 160;

  function clip(value: string | null | undefined): string | undefined {
    if (value === null || value === undefined) return undefined;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed;
  }

  /** Mirrors `implicitRole` in dom-inspector-script.ts. */
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

  /** Mirrors `accessibleName` in dom-inspector-script.ts. */
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

  const topmost = document.elementFromPoint(point.x, point.y);
  if (topmost === null) return null;

  /*
   * Clicking a button's label means the button.
   *
   * `elementFromPoint` returns the topmost node, which for a styled control is
   * often an inner span. Walking up to the nearest element a user could act on
   * is what makes a click land on the thing they meant.
   */
  const INTERACTIVE = ['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option'];
  let element: Element = topmost;
  for (let depth = 0; depth < 6; depth += 1) {
    const tag = element.tagName.toLowerCase();
    const clickable =
      INTERACTIVE.includes(tag) ||
      element.getAttribute('role') !== null ||
      element.hasAttribute('onclick') ||
      (element as HTMLElement).tabIndex >= 0;
    if (clickable) break;

    const parent = element.parentElement;
    if (parent === null || parent === document.body) break;
    element = parent;
  }

  const rect = element.getBoundingClientRect();
  const target = element as HTMLElement;
  const tag = element.tagName.toLowerCase();

  const result: PointPickResult = {
    tag,
    attributes: Object.fromEntries(
      Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value]),
    ) as Record<string, string>,
    // Computed in the page: only the page knows whether an ancestor hides or
    // disables this element.
    visible: rect.width > 0 && rect.height > 0,
    enabled: !(element as HTMLInputElement).disabled,
    editable: target.isContentEditable || ['input', 'textarea', 'select'].includes(tag),
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    // Document order. Deliberately *not* comparable to a snapshot's
    // runtimeIds: the inspector numbers the elements that pass its filter, and
    // it can be rooted at a container, so the two counters are unrelated. Where
    // something needs to know whether a describe landed on the element that was
    // scanned, it compares geometry — see `describeLandedElsewhere` in the
    // workspace's registry export.
    domIndex: Array.from(document.querySelectorAll('*')).indexOf(element),
  };

  const role = implicitRole(element);
  if (role !== undefined) result.role = role;

  const name = accessibleName(element);
  if (name !== undefined) result.accessibleName = name;

  const text = clip(element.textContent);
  if (text !== undefined) result.text = text;

  return result;
}

/**
 * Describes one already-located element, serialized into the page.
 *
 * Shares its role and name resolution with `describeAtPointScript` by being
 * defined in the same module and inlining the same helpers — an evaluated
 * function cannot import, and two different answers for one element is exactly
 * the bug this file's parity test exists to prevent.
 */
export function describeElementScript(element: Element): Omit<PointPickResult, 'domIndex'> {
  const MAX_TEXT = 160;

  function clip(value: string | null | undefined): string | undefined {
    if (value === null || value === undefined) return undefined;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed;
  }

  /** Mirrors `implicitRole` in dom-inspector-script.ts. */
  function implicitRole(node: Element): string | undefined {
    const explicit = node.getAttribute('role');
    if (explicit !== null && explicit.length > 0) return explicit;

    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case 'button':
        return 'button';
      case 'a':
        return node.hasAttribute('href') ? 'link' : undefined;
      case 'textarea':
        return 'textbox';
      case 'select':
        return node.hasAttribute('multiple') ? 'listbox' : 'combobox';
      case 'summary':
        return 'button';
      case 'input': {
        const type = (node.getAttribute('type') ?? 'text').toLowerCase();
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

  /** Mirrors `accessibleName` in dom-inspector-script.ts. */
  function accessibleName(node: Element): string | undefined {
    const ariaLabel = clip(node.getAttribute('aria-label'));
    if (ariaLabel !== undefined) return ariaLabel;

    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => clip(document.getElementById(id)?.textContent))
        .filter((name): name is string => name !== undefined);
      if (names.length > 0) return names.join(' ');
    }

    const id = node.getAttribute('id');
    if (id !== null && id.length > 0) {
      const escaped = window.CSS?.escape ? window.CSS.escape(id) : id;
      const label = clip(document.querySelector(`label[for="${escaped}"]`)?.textContent);
      if (label !== undefined) return label;
    }

    const wrappingLabel = node.closest('label');
    if (wrappingLabel !== null) {
      const label = clip(wrappingLabel.textContent);
      if (label !== undefined) return label;
    }

    const tag = node.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (node.getAttribute('type') ?? '').toLowerCase();
      if (type === 'submit' || type === 'button') {
        const value = clip(node.getAttribute('value'));
        if (value !== undefined) return value;
      }
      const placeholder = clip(node.getAttribute('placeholder'));
      if (placeholder !== undefined) return placeholder;
    }
    if (tag === 'img') {
      const alt = clip(node.getAttribute('alt'));
      if (alt !== undefined) return alt;
    }

    return clip(node.textContent);
  }

  const rect = element.getBoundingClientRect();
  const target = element as HTMLElement;
  const tag = element.tagName.toLowerCase();

  const result: Omit<PointPickResult, 'domIndex'> = {
    tag,
    attributes: Object.fromEntries(
      Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value]),
    ) as Record<string, string>,
    visible: rect.width > 0 && rect.height > 0,
    enabled: !(element as HTMLInputElement).disabled,
    editable: target.isContentEditable || ['input', 'textarea', 'select'].includes(tag),
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };

  const role = implicitRole(element);
  if (role !== undefined) result.role = role;

  const name = accessibleName(element);
  if (name !== undefined) result.accessibleName = name;

  const text = clip(element.textContent);
  if (text !== undefined) result.text = text;

  return result;
}
