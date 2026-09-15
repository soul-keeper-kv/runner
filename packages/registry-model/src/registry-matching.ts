import type { ElementRegistryItem, NameSource } from './registry-element.js';

/**
 * Name matching for Registry lookups (blueprint section 16).
 *
 * The Registry resolves an intent by *meaning*, so a caller that asks for
 * "Login" must find an element a human named "Sign in Button". That is textual
 * matching, and it lives here rather than in the store adapter for two reasons:
 * it is a policy decision worth unit-testing without a database, and both the
 * API adapter and the worker need the identical answer — two implementations
 * that disagree would make a lookup's result depend on which process ran it.
 *
 * It deliberately does not import the worker's `similarity()`. That function
 * ranks live DOM candidates and lives in `apps/worker`, which this package must
 * not depend on; the normalization below is kept consistent with it on purpose,
 * and `registry-matching.test.ts` pins the behaviour both rely on.
 */

/** How a lookup matched, strongest first. Mirrors `RESOLUTION_ORDER`. */
export type RegistryMatchKind =
  | 'ID'
  | 'DISPLAY_NAME'
  | 'ALIAS'
  | 'SYSTEM_NAME'
  | 'DESCRIPTION';

/**
 * Base score per match kind, before text similarity is folded in.
 *
 * The ordering encodes whose decision a match reflects: an id is unambiguous,
 * a display name is a current human decision, an alias is a past or suggested
 * one, and a description match is inference.
 */
export const MATCH_KIND_WEIGHTS: Readonly<Record<RegistryMatchKind, number>> = {
  ID: 1,
  DISPLAY_NAME: 0.95,
  ALIAS: 0.85,
  SYSTEM_NAME: 0.8,
  DESCRIPTION: 0.6,
};

/** Words carrying no discriminating power in UI labels. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'for',
  'and',
  'or',
  'button',
  'field',
  'input',
  'link',
  'icon',
]);

export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  const tokens = value.split(' ').filter((token) => token.length > 1);
  const meaningful = tokens.filter((token) => !STOP_WORDS.has(token));
  // "Button" alone is a legitimate query; fall back rather than return nothing.
  return meaningful.length > 0 ? meaningful : tokens;
}

/**
 * Token-overlap similarity with an exact-match shortcut, in 0..1.
 *
 * Token overlap rather than edit distance because UI labels differ by whole
 * words far more often than by characters: "Login" vs "Log in" vs "Sign in".
 */
export function nameSimilarity(rawA: string, rawB: string): number {
  const a = normalizeName(rawA);
  const b = normalizeName(rawB);

  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setB = new Set(tokensB);
  const shared = tokensA.filter((token) => setB.has(token)).length;
  const overlap = shared / Math.max(tokensA.length, tokensB.length);

  // A full substring match is strong evidence even when token counts differ,
  // e.g. "Login" against "Login Button".
  const containment = b.includes(a) || a.includes(b) ? 0.3 : 0;

  return Math.min(1, overlap + containment);
}

/** Below this, a textual match is too weak to offer as a resolution. */
export const MIN_NAME_MATCH_SIMILARITY = 0.4;

export interface NameMatch {
  readonly kind: RegistryMatchKind;
  /** 0..1, combining the match kind's authority with text similarity. */
  readonly score: number;
  /** The stored text that matched, for evidence. */
  readonly matchedText: string;
  /** For an alias hit, who authored the alias. */
  readonly source?: NameSource;
}

/**
 * The single strongest way `query` matches `element`, or undefined.
 *
 * Only the best match is returned: a caller ranking candidates needs one
 * comparable score per element, and reporting that an element matched both a
 * display name and an alias would double-count the same evidence.
 */
export function matchElementByName(
  element: ElementRegistryItem,
  query: string,
): NameMatch | undefined {
  const normalizedQuery = normalizeName(query);
  if (normalizedQuery.length === 0) return undefined;

  const candidates: NameMatch[] = [];

  const byDisplayName = nameSimilarity(query, element.displayName);
  if (byDisplayName > 0) {
    candidates.push({
      kind: 'DISPLAY_NAME',
      score: byDisplayName * MATCH_KIND_WEIGHTS.DISPLAY_NAME,
      matchedText: element.displayName,
    });
  }

  for (const alias of element.aliases) {
    const score = nameSimilarity(query, alias.value);
    if (score === 0) continue;
    candidates.push({
      kind: 'ALIAS',
      score: score * MATCH_KIND_WEIGHTS.ALIAS,
      matchedText: alias.value,
      source: alias.source,
    });
  }

  // systemName is compared on its normalized form so "createCustomerButton"
  // still answers to "Create Customer Button".
  const bySystemName = nameSimilarity(query, splitSystemName(element.systemName));
  if (bySystemName > 0) {
    candidates.push({
      kind: 'SYSTEM_NAME',
      score: bySystemName * MATCH_KIND_WEIGHTS.SYSTEM_NAME,
      matchedText: element.systemName,
    });
  }

  if (element.description !== undefined) {
    const byDescription = nameSimilarity(query, element.description);
    if (byDescription > 0) {
      candidates.push({
        kind: 'DESCRIPTION',
        score: byDescription * MATCH_KIND_WEIGHTS.DESCRIPTION,
        matchedText: element.description,
      });
    }
  }

  if (candidates.length === 0) return undefined;

  const best = candidates.reduce((strongest, candidate) =>
    candidate.score > strongest.score ? candidate : strongest,
  );

  return best.score >= MIN_NAME_MATCH_SIMILARITY * MATCH_KIND_WEIGHTS.DESCRIPTION
    ? best
    : undefined;
}

/** `createCustomerButton` -> `create Customer Button`, for comparison. */
export function splitSystemName(systemName: string): string {
  return systemName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}
