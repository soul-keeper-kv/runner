import type { ElementCandidate, PageSnapshot } from '@runner/domain';
import { labelOf } from '@runner/domain';
import type {
  InspectionControlV1,
  InspectionFieldV1,
  InspectionSelectorV1,
} from '@runner/test-ir-model';
import type { ScoredSelector } from '@runner/selector-model';
import type { LocatorGenerator } from '../locator/locator-generator.js';

/**
 * Projects a page snapshot onto the published inspection result.
 *
 * This is the piece that answers the question the inspection API exists for:
 * *what does a caller have to fill in on this page?* The snapshot describes
 * every interactable element; this narrows it to the controls that take a
 * value, names each one the way a human would, and attaches a ranked selector
 * so the caller can act on it without a second round trip.
 *
 * Pure and browser-free by design (blueprint section 13): generation, scoring
 * and this projection are all testable before any page exists.
 */

export interface ExtractOptions {
  readonly includeNonInputControls?: boolean;
}

export interface ExtractedPage {
  readonly fields: InspectionFieldV1[];
  readonly submit?: InspectionControlV1;
  readonly controls?: InspectionControlV1[];
}

/** Input types that carry no user-supplied value. */
const NON_VALUE_INPUT_TYPES = new Set(['submit', 'reset', 'button', 'image', 'hidden']);

/** Roles whose elements accept a value even though they are not <input>. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton']);

const CHOICE_ROLES = new Set(['checkbox', 'radio', 'switch']);

export function extractPage(
  snapshot: PageSnapshot,
  generator: LocatorGenerator,
  options: ExtractOptions = {},
): ExtractedPage {
  const fields: InspectionFieldV1[] = [];
  const otherControls: InspectionControlV1[] = [];
  let submit: InspectionControlV1 | undefined;

  for (const candidate of snapshot.elements) {
    if (!candidate.visible) continue;

    if (isValueField(candidate)) {
      fields.push(toField(candidate, generator));
      continue;
    }

    const control = toControl(candidate, generator);
    if (control === undefined) continue;

    // The first submit-like control wins: forms are read top to bottom, and a
    // page's own submit button precedes footer actions like "Manage cookies".
    if (submit === undefined && isSubmitLike(candidate)) {
      submit = control;
      continue;
    }

    if (options.includeNonInputControls === true) otherControls.push(control);
  }

  const result: ExtractedPage = {
    fields,
    ...(submit === undefined ? {} : { submit }),
    ...(options.includeNonInputControls === true ? { controls: otherControls } : {}),
  };
  return result;
}

/**
 * Whether the element takes a value the caller would have to supply.
 *
 * Checkboxes and radios count: a caller filling a form has to decide about
 * them, even though they are selected rather than typed into.
 */
function isValueField(candidate: ElementCandidate): boolean {
  const tag = candidate.tag;
  const type = (candidate.attributes.type ?? '').toLowerCase();

  if (tag === 'input') return !NON_VALUE_INPUT_TYPES.has(type);
  if (tag === 'textarea' || tag === 'select') return true;
  if (candidate.editable) return true;

  const role = candidate.role;
  if (role === undefined) return false;
  return VALUE_ROLES.has(role) || CHOICE_ROLES.has(role);
}

function isSubmitLike(candidate: ElementCandidate): boolean {
  const type = (candidate.attributes.type ?? '').toLowerCase();
  if (candidate.tag === 'input' && type === 'submit') return true;
  if (candidate.tag === 'button' && (type === 'submit' || type === '')) return true;
  return false;
}

/**
 * The field's human-facing name.
 *
 * Preference order matters: the accessible name is what the page shows the
 * user, so it is what a caller's own prompt or mapping will be written
 * against. The `name` attribute is reported separately rather than used here,
 * because it is often absent, abbreviated or machine-generated.
 */
function displayNameOf(candidate: ElementCandidate): string {
  return (
    candidate.accessibleName ??
    candidate.attributes['aria-label'] ??
    candidate.attributes.placeholder ??
    candidate.attributes.name ??
    labelOf(candidate)
  );
}

function fieldTypeOf(candidate: ElementCandidate): string {
  if (candidate.tag === 'input') return (candidate.attributes.type ?? 'text').toLowerCase();
  if (candidate.tag === 'textarea') return 'textarea';
  if (candidate.tag === 'select') {
    return candidate.attributes.multiple === undefined ? 'select' : 'select-multiple';
  }
  return candidate.role ?? candidate.tag;
}

function toField(candidate: ElementCandidate, generator: LocatorGenerator): InspectionFieldV1 {
  const ranked = generator.generate(candidate);
  const [primary, ...rest] = ranked;

  const field: Record<string, unknown> = {
    name: displayNameOf(candidate),
    type: fieldTypeOf(candidate),
    required: isRequired(candidate),
    enabled: candidate.enabled,
    selector: toSelector(primary),
    fallbacks: rest.slice(0, 4).map(toSelector),
  };

  const fieldName = candidate.attributes.name;
  if (fieldName !== undefined) field.fieldName = fieldName;

  const placeholder = candidate.attributes.placeholder;
  if (placeholder !== undefined) field.placeholder = placeholder;

  return field as unknown as InspectionFieldV1;
}

function toControl(
  candidate: ElementCandidate,
  generator: LocatorGenerator,
): InspectionControlV1 | undefined {
  if (!candidate.interactable) return undefined;

  const ranked = generator.generate(candidate);
  const [primary, ...rest] = ranked;
  if (primary === undefined) return undefined;

  return {
    name: displayNameOf(candidate),
    role: candidate.role ?? candidate.tag,
    selector: toSelector(primary),
    fallbacks: rest.slice(0, 4).map(toSelector),
  };
}

/**
 * `required` is reported only when the page actually says so.
 *
 * A caller uses this to decide what it must provide; inferring it from
 * anything softer than an explicit attribute would turn a guess into an
 * apparent fact.
 */
function isRequired(candidate: ElementCandidate): boolean {
  return (
    candidate.attributes.required !== undefined ||
    candidate.attributes['aria-required'] === 'true'
  );
}

/**
 * Flattens a scored selector onto the wire shape.
 *
 * A candidate with no usable signal at all (no id, name, role, text or test id)
 * yields no selector; rather than invent one — a positional CSS path would be
 * the worst kind of selector to hand a caller — it reports a zero-score `none`,
 * which is honest and visibly unusable.
 */
function toSelector(scored: ScoredSelector | undefined): InspectionSelectorV1 {
  if (scored === undefined) {
    return { type: 'none', score: 0 };
  }

  const { selector, score } = scored;
  const flattened: Record<string, unknown> = { type: selector.type, score };

  if ('value' in selector && selector.value !== undefined) flattened.value = selector.value;
  if ('role' in selector && selector.role !== undefined) flattened.role = selector.role;
  if ('name' in selector && selector.name !== undefined) flattened.name = selector.name;

  return flattened as unknown as InspectionSelectorV1;
}
