import type { SelectorDefinition } from '@runner/selector-model';

/**
 * Builds a downloadable registry draft from what a live scan found.
 *
 * The workspace can already see every element on the page and, once described,
 * every ranked selector for each one. What it could not do was hand that to
 * anyone: the data lived in a panel. This turns it into the same *draft
 * registry entry* shape an inspection returns, so one file is consumable by
 * Page Object generation whether it came from `POST /inspections` or from a
 * live session the user was already standing in.
 *
 * They are drafts, emphatically. Nothing here writes to the Registry — blueprint
 * rule 7 routes every registry change through a draft modification, and a file
 * that looked like a committed entry would invite someone to bypass that.
 */

/** A selector as the export renders it, mirroring `InspectionSelectorV1`. */
export interface ExportedSelector {
  type: string;
  value?: string;
  role?: string;
  name?: string;
  score: number;
  /** How many elements this matched when checked against the live page. */
  matchCount?: number;
}

/** One draft registry entry. Shaped after `InspectionElementV1`. */
export interface ExportedElement {
  systemName: string;
  displayName: string;
  role: string;
  interactable: boolean;
  selector?: ExportedSelector;
  fallbacks: ExportedSelector[];
  bbox?: { x: number; y: number; width: number; height: number };
  /** Set when the element is already known to the Registry. */
  matchedElementId?: string;
  /**
   * Set when describing this element returned a *different* element than the
   * one scanned. Reported rather than dropped: a covered element yields a
   * selector for whatever sits on top of it, and silently writing that into a
   * registry draft is how a generated Page Object clicks the wrong control.
   */
  describeMismatch?: boolean;
  /** Absent when the element was never described, so no selector was ranked. */
  described: boolean;
}

/** A rectangle in the page's viewport coordinates. */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegistryExport {
  contractVersion: 'runner.registry.draft.v1';
  source: 'live-session' | 'live-session-region' | 'inspection';
  url: string;
  title?: string;
  capturedAt: string;
  /**
   * The region the user drew, when this export covers one part of the page.
   *
   * Recorded because the element count alone cannot distinguish "this page has
   * seven elements" from "I exported seven of this page's elements". A reader
   * who cannot tell the difference concludes the file is incomplete and rescans
   * the whole page, which is the work the region was meant to avoid.
   */
  region?: ViewportRect;
  elementCount: number;
  describedCount: number;
  /**
   * Set when the page held more elements than the scan returned.
   *
   * The worker caps a snapshot's candidates to keep a frame small. A file
   * claiming to be "every element" while quietly omitting some is the kind of
   * thing someone discovers after generating a Page Object, so the shortfall is
   * recorded here rather than left to be inferred from the count.
   */
  truncated?: { returned: number; available: number };
  elements: ExportedElement[];
}

/** The scan input: a candidate from `state.inspect`, optionally described. */
export interface ScannedElement {
  runtimeId: string;
  tag: string;
  role?: string;
  label?: string;
  interactable: boolean;
  bbox?: { x: number; y: number; width: number; height: number };
  described?: {
    runtimeId: string;
    /**
     * The box the describe actually landed on.
     *
     * Kept separate from the scanned `bbox` above so the two can be compared:
     * a describe that hit a covering element reports that element's geometry,
     * and geometry is the only thing the two inspections express in the same
     * terms — their `runtimeId`s come from unrelated counters.
     */
    bbox?: { x: number; y: number; width: number; height: number };
    accessibleName?: string;
    text?: string;
    matchedElementId?: string;
    candidateSelectors: {
      selector: SelectorDefinition;
      score: number;
      matchCount: number;
    }[];
  };
}

export function buildRegistryExport(
  scanned: readonly ScannedElement[],
  page: { url: string; title?: string; candidateCount?: number; region?: ViewportRect },
): RegistryExport {
  const usedNames = new Map<string, number>();

  const elements = scanned.map((element) => toExportedElement(element, usedNames));

  // Only when the page genuinely held more than came back. Recording a
  // shortfall of zero on every export would train a reader to ignore the field.
  //
  // A region export is scoped by the user's own rectangle, not by the worker's
  // candidate cap, so the shortfall is meaningless there: every element outside
  // the region is missing *by request*, and reporting that as truncation would
  // describe an intentional scope as data loss.
  const available = page.candidateCount;
  const truncated =
    page.region === undefined && available !== undefined && available > elements.length
      ? { returned: elements.length, available }
      : undefined;

  return {
    contractVersion: 'runner.registry.draft.v1',
    source: page.region === undefined ? 'live-session' : 'live-session-region',
    url: page.url,
    ...(page.title === undefined ? {} : { title: page.title }),
    capturedAt: new Date().toISOString(),
    ...(page.region === undefined ? {} : { region: page.region }),
    elementCount: elements.length,
    describedCount: elements.filter((element) => element.described).length,
    ...(truncated === undefined ? {} : { truncated }),
    elements,
  };
}

function toExportedElement(
  element: ScannedElement,
  usedNames: Map<string, number>,
): ExportedElement {
  const described = element.described;
  const displayName =
    described?.accessibleName ?? element.label ?? described?.text ?? element.tag;

  const [primary, ...rest] = described?.candidateSelectors ?? [];

  const exported: ExportedElement = {
    systemName: uniqueSystemName(displayName, usedNames),
    displayName,
    role: element.role ?? element.tag,
    interactable: element.interactable,
    fallbacks: rest.slice(0, 4).map(toExportedSelector),
    described: described !== undefined,
  };

  if (primary !== undefined) exported.selector = toExportedSelector(primary);
  if (element.bbox !== undefined) exported.bbox = element.bbox;
  if (described?.matchedElementId !== undefined) {
    exported.matchedElementId = described.matchedElementId;
  }
  if (describeLandedElsewhere(element, described)) exported.describeMismatch = true;

  return exported;
}

/**
 * Whether describing this element returned a *different* element.
 *
 * Compared by geometry, not by `runtimeId`. The two ids come from different
 * counters — the page inspector numbers the elements that pass its filter, and
 * the point-pick script numbers its own walk of the document — so they are
 * never equal even when both describe the same element. Comparing them marked
 * almost everything as mismatched, which is worse than no check at all: a flag
 * that fires on every row teaches the reader to ignore it.
 *
 * A describe that hits a covering element reports that element's box, so an
 * overlap test is the signal that actually distinguishes the two cases.
 */
function describeLandedElsewhere(
  element: ScannedElement,
  described: ScannedElement['described'],
): boolean {
  if (described === undefined) return false;

  const scanned = element.bbox;
  const hit = described.bbox;
  // Nothing to compare: reporting a mismatch on missing geometry would be a
  // guess, and this flag exists to be trusted.
  if (scanned === undefined || hit === undefined) return false;

  return overlapRatio(scanned, hit) < MIN_BBOX_OVERLAP;
}

/**
 * Whether an element sits entirely inside the region the user drew.
 *
 * Containment rather than intersection, and that choice is the whole point of
 * the feature. An intersection test keeps every ancestor that merely overlaps
 * the rectangle — `<body>`, the page wrapper, the card the region sits in — so
 * a region drawn around a login form still exports the containers the user was
 * trying to exclude, and they go back to editing the file by hand.
 *
 * The cost is the opposite error: an element clipped by the region's edge is
 * dropped. That one is visible and recoverable — the overlay shows what is
 * selected before the scan runs, so the user redraws slightly wider — whereas a
 * silently included wrapper is only discovered after generating a Page Object.
 *
 * An element with no geometry is excluded: it cannot be shown to be inside, and
 * a region scan that quietly included unplaceable elements would not be scoped.
 */
export function containedInRegion(
  bbox: { x: number; y: number; width: number; height: number } | undefined,
  region: ViewportRect,
): boolean {
  if (bbox === undefined) return false;

  return (
    bbox.x >= region.x &&
    bbox.y >= region.y &&
    bbox.x + bbox.width <= region.x + region.width &&
    bbox.y + bbox.height <= region.y + region.height
  );
}

/**
 * How much of the scanned box the described box covers, 0..1.
 *
 * Intersection over the scanned element's own area rather than over the union:
 * describing a small control inside a large covering panel should read as a
 * mismatch, and a union-based ratio would dilute that to near zero for every
 * size difference, mismatched or not.
 */
function overlapRatio(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const area = a.width * a.height;
  if (area <= 0) return 0;

  const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

  return (overlapWidth * overlapHeight) / area;
}

/**
 * Below this, the described element is treated as a different one.
 *
 * Generous on purpose: sub-pixel layout differences between two inspections of
 * the same page are normal, and a false mismatch costs more than a missed one —
 * the flag's whole value is that a reader can believe it.
 */
const MIN_BBOX_OVERLAP = 0.5;

function toExportedSelector(entry: {
  selector: SelectorDefinition;
  score: number;
  matchCount: number;
}): ExportedSelector {
  const selector = entry.selector as {
    type: string;
    value?: string;
    role?: string;
    name?: string;
  };

  return {
    type: selector.type,
    ...(selector.value === undefined ? {} : { value: selector.value }),
    ...(selector.role === undefined ? {} : { role: selector.role }),
    ...(selector.name === undefined ? {} : { name: selector.name }),
    score: entry.score,
    matchCount: entry.matchCount,
  };
}

/**
 * A code identifier that is unique within the export.
 *
 * Duplicated from `toSystemName` in `@runner/shared` rather than imported: the
 * workspace depends only on the wire-protocol packages, and pulling a server
 * utility package into the browser bundle to reuse thirty lines would widen
 * that dependency for every future change to `shared`. The rule it encodes —
 * blueprint section 46, generated identifiers are never raw user text — is
 * stable, and `registry-export.test.ts` pins the two to the same outputs.
 */
export function toSystemName(displayName: string): string {
  const words = displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) return 'unnamedElement';

  const [first, ...rest] = words as [string, ...string[]];
  const head = first.toLowerCase();
  const tail = rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  const candidate = [head, ...tail].join('');

  return /^[0-9]/.test(candidate)
    ? `el${candidate.charAt(0).toUpperCase()}${candidate.slice(1)}`
    : candidate;
}

/**
 * Two "Edit" buttons in a table would otherwise generate one property on a Page
 * Object, and the second would silently overwrite the first.
 */
function uniqueSystemName(displayName: string, usedNames: Map<string, number>): string {
  const base = toSystemName(displayName);
  const seen = usedNames.get(base);

  if (seen === undefined) {
    usedNames.set(base, 1);
    return base;
  }

  usedNames.set(base, seen + 1);
  return `${base}${seen + 1}`;
}

/** Triggers a browser download of `value` as pretty-printed JSON. */
export function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();

  // Revoked on the next tick rather than immediately: Safari has not finished
  // reading the blob when `click()` returns, and a revoked URL downloads an
  // empty file.
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

/** A filesystem-safe filename stem for a page. */
export function filenameForUrl(url: string, suffix: string): string {
  let stem = 'page';
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    stem = `${parsed.hostname}${segment === undefined ? '' : `-${segment}`}`;
  } catch {
    // A session that never navigated has no parsable URL; the generic stem is
    // better than refusing the download.
  }

  return `${stem.replace(/[^a-zA-Z0-9.-]+/g, '-')}-${suffix}.json`;
}
