/**
 * A structured view of one interactable element on the current page
 * (blueprint section 10).
 *
 * This exists to avoid the failure mode the blueprint warns about: sending
 * `document.documentElement.outerHTML` anywhere. A page of 10,000 nodes reduces
 * to roughly a hundred of these, each carrying only the signals that actually
 * discriminate between elements.
 */

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Surrounding context that disambiguates otherwise identical elements. */
export interface ElementContext {
  readonly parentText?: string;
  readonly nearbyText?: readonly string[];
  /** Heuristic component name, e.g. from a data-component attribute. */
  readonly componentHint?: string;
  /** Name or id of the enclosing form. */
  readonly formHint?: string;
  readonly frameId?: string;
  /** Present when the element lives inside a shadow root. */
  readonly shadowHost?: string;
  /** Ancestor landmark role, e.g. "navigation", "main", "dialog". */
  readonly landmark?: string;
}

export interface ElementCandidate {
  /** Identifies the element within one snapshot only. Never persisted. */
  readonly runtimeId: string;

  readonly tag: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly text?: string;

  readonly attributes: Readonly<Record<string, string>>;

  readonly visible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
  /** Visible, enabled and not covered by another element. */
  readonly interactable: boolean;

  readonly bbox?: BoundingBox;
  readonly context?: ElementContext;

  /** DOM depth, used as a tie-breaker when scores are equal. */
  readonly depth?: number;
  /** Document order index, for stable sorting. */
  readonly domIndex?: number;
}

/** Attributes worth capturing; everything else is noise for resolution. */
export const SIGNIFICANT_ATTRIBUTES: readonly string[] = [
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

/** Test-id attributes in priority order; the first present one wins. */
export const TEST_ID_ATTRIBUTES: readonly string[] = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
];

export function testIdOf(candidate: ElementCandidate): string | undefined {
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = candidate.attributes[attribute];
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

/** The best human-readable label available, for logs and proposals. */
export function labelOf(candidate: ElementCandidate): string {
  return (
    candidate.accessibleName ??
    candidate.text ??
    candidate.attributes['aria-label'] ??
    candidate.attributes.placeholder ??
    candidate.attributes.name ??
    candidate.attributes.id ??
    candidate.tag
  );
}

export function describeCandidate(candidate: ElementCandidate): string {
  const role = candidate.role === undefined ? candidate.tag : `${candidate.tag}[${candidate.role}]`;
  return `${role} "${labelOf(candidate)}"`;
}
