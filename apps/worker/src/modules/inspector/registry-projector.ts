import type { ElementCandidate, PageSnapshot } from '@runner/domain';
import { labelOf } from '@runner/domain';
import type {
  InspectionElementV1,
  InspectionPageV1,
  InspectionSelectorV1,
} from '@runner/test-ir-model';
import type { ScoredSelector } from '@runner/selector-model';
import { toSystemName } from '@runner/shared';
import type { LocatorGenerator } from '../locator/locator-generator.js';

/**
 * Projects a page snapshot onto *draft registry entries*.
 *
 * This is the piece that makes an inspection useful beyond "list the inputs":
 * every element comes back shaped like a Registry element, so Page Object
 * generation has everything it needs — a generated `systemName` to emit as an
 * identifier, a human `displayName`, ranked selectors with fallbacks, and a
 * confidence score.
 *
 * They are explicitly *drafts*. Nothing here writes to the Registry: blueprint
 * rule 7 requires every registry change to go through a modification, and an
 * inspection that silently created entries would defeat the audit trail that
 * rule exists to protect. Persisting these is a separate, deliberate step.
 *
 * Pure and browser-free, so the naming and ranking rules are unit-testable
 * before any page exists.
 */

export interface ProjectedPage {
  readonly page: InspectionPageV1;
  readonly elements: InspectionElementV1[];
}

const NON_VALUE_INPUT_TYPES = new Set(['submit', 'reset', 'button', 'image', 'hidden']);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton']);
const CHOICE_ROLES = new Set(['checkbox', 'radio', 'switch']);

export function projectRegistry(
  snapshot: PageSnapshot,
  generator: LocatorGenerator,
): ProjectedPage {
  const elements: InspectionElementV1[] = [];
  const usedNames = new Map<string, number>();

  for (const candidate of snapshot.elements) {
    if (!candidate.visible) continue;

    const projected = toElement(candidate, generator, usedNames);
    if (projected !== undefined) elements.push(projected);
  }

  return { page: toPage(snapshot), elements };
}

function toPage(snapshot: PageSnapshot): InspectionPageV1 {
  const displayName = snapshot.title ?? urlTail(snapshot.url);
  return {
    // The identifier comes from the title's leading segment, not the whole
    // title: "Sign in to GitHub · GitHub" would otherwise generate
    // `signInToGithubGithub`, and that name is what code generation emits.
    systemName: toSystemName(titleStem(displayName)),
    displayName,
    // The exact URL, not a guessed glob: inventing a pattern that silently
    // matches unrelated pages would be worse than a pattern a caller widens.
    urlPattern: snapshot.url,
  };
}

/**
 * The meaningful part of a page title.
 *
 * Sites conventionally append their own name after a separator — "Login · Acme",
 * "Checkout | Shop", "Sign up – Example". The leading segment is the page; the
 * rest is the site, and repeating it in an identifier only adds noise.
 */
function titleStem(title: string): string {
  const stem = title.split(/\s+[·|–—»>]\s+/)[0]?.trim();
  return stem === undefined || stem.length === 0 ? title : stem;
}

function urlTail(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    return segment ?? parsed.hostname;
  } catch {
    return 'page';
  }
}

function toElement(
  candidate: ElementCandidate,
  generator: LocatorGenerator,
  usedNames: Map<string, number>,
): InspectionElementV1 | undefined {
  const ranked = generator.generate(candidate);
  const [primary, ...rest] = ranked;

  const displayName = displayNameOf(candidate);
  const systemName = uniqueSystemName(displayName, usedNames);

  const element: Record<string, unknown> = {
    systemName,
    displayName,
    role: candidate.role ?? candidate.tag,
    semanticType: semanticTypeOf(candidate),
    interactable: candidate.interactable,
    editable: candidate.editable,
    enabled: candidate.enabled,
    required: isRequired(candidate),
    selector: toSelector(primary),
    fallbacks: rest.slice(0, 4).map(toSelector),
    confidence: confidenceOf(primary, candidate),
  };

  const aliases = aliasesOf(candidate, displayName);
  if (aliases.length > 0) element.aliases = aliases;

  if (isValueField(candidate)) element.fieldType = fieldTypeOf(candidate);

  const fieldName = candidate.attributes.name;
  if (fieldName !== undefined) element.fieldName = fieldName;

  const placeholder = candidate.attributes.placeholder;
  if (placeholder !== undefined) element.placeholder = placeholder;

  const description = candidate.context?.parentText;
  if (description !== undefined && description !== displayName) {
    element.description = description;
  }

  return element as unknown as InspectionElementV1;
}

/**
 * A code identifier that is unique within the page.
 *
 * Two "Edit" buttons in a table would otherwise generate the same property on a
 * Page Object, and the second would silently overwrite the first.
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

function displayNameOf(candidate: ElementCandidate): string {
  return (
    candidate.accessibleName ??
    candidate.attributes['aria-label'] ??
    candidate.attributes.placeholder ??
    candidate.attributes.name ??
    labelOf(candidate)
  );
}

/**
 * Other names the element answers to, learned from the page itself.
 *
 * These become Registry aliases: the phrases a person might use for this
 * element that are not its display name. Learned names are UI_TEXT-sourced and
 * must never outrank a user-authored one later.
 */
function aliasesOf(candidate: ElementCandidate, displayName: string): string[] {
  const candidates = [
    candidate.attributes.placeholder,
    candidate.attributes.name,
    candidate.attributes.title,
    candidate.text,
  ];

  const aliases: string[] = [];
  for (const value of candidates) {
    if (value === undefined || value.length === 0) continue;
    if (value === displayName) continue;
    if (value.length > 60) continue;
    if (!aliases.includes(value)) aliases.push(value);
  }
  return aliases;
}

function semanticTypeOf(candidate: ElementCandidate): string {
  if (isValueField(candidate)) {
    const role = candidate.role;
    if (role !== undefined && CHOICE_ROLES.has(role)) return 'choice';
    return 'input';
  }
  const role = candidate.role ?? candidate.tag;
  if (role === 'button') return 'button';
  if (role === 'link' || candidate.tag === 'a') return 'link';
  return role;
}

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

function fieldTypeOf(candidate: ElementCandidate): string {
  if (candidate.tag === 'input') return (candidate.attributes.type ?? 'text').toLowerCase();
  if (candidate.tag === 'textarea') return 'textarea';
  if (candidate.tag === 'select') {
    return candidate.attributes.multiple === undefined ? 'select' : 'select-multiple';
  }
  return candidate.role ?? candidate.tag;
}

function isRequired(candidate: ElementCandidate): boolean {
  return (
    candidate.attributes.required !== undefined ||
    candidate.attributes['aria-required'] === 'true'
  );
}

/**
 * Confidence for an element seen for the first time.
 *
 * The Registry's own formula folds in success history and human confirmation,
 * neither of which exists on a first sighting. So this reports selector
 * strength alone, mildly reduced for an element that cannot be interacted with.
 *
 * It is scaled rather than clamped. Clamping at the ceiling would report a
 * strong `data-testid` and a weak class selector as the same number, throwing
 * away the ranking the locator engine just computed — the scale keeps those
 * apart while holding every first sighting below the 0.95 auto-execute
 * threshold, because one look at a page is not grounds for acting unattended.
 */
const FIRST_SIGHTING_CEILING = 0.94;

function confidenceOf(primary: ScoredSelector | undefined, candidate: ElementCandidate): number {
  if (primary === undefined) return 0;

  const base = Math.min(Math.max(primary.score, 0), 100) / 100;
  const adjusted = candidate.interactable ? base : base * 0.9;
  return Math.round(adjusted * FIRST_SIGHTING_CEILING * 100) / 100;
}

function toSelector(scored: ScoredSelector | undefined): InspectionSelectorV1 {
  if (scored === undefined) return { type: 'none', score: 0 };

  const { selector, score } = scored;
  const flattened: Record<string, unknown> = { type: selector.type, score };

  if ('value' in selector && selector.value !== undefined) flattened.value = selector.value;
  if ('role' in selector && selector.role !== undefined) flattened.role = selector.role;
  if ('name' in selector && selector.name !== undefined) flattened.name = selector.name;

  return flattened as unknown as InspectionSelectorV1;
}
