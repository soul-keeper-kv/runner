import type { ElementCandidate, ElementIntent } from '@runner/domain';
import { labelOf } from '@runner/domain';

/**
 * Narrows a page snapshot to the candidates worth considering
 * (blueprint section 11).
 *
 * A page has thousands of nodes; roughly a hundred are interactable; usually
 * fewer than ten could plausibly be the target. Doing this filtering
 * deterministically — before any scoring and long before any model — is what
 * keeps resolution fast, explainable, and cheap enough that an LLM, when one is
 * eventually added, only ever sees a shortlist (blueprint section 45).
 */

export interface FilterOptions {
  readonly requireVisible?: boolean;
  readonly requireEnabled?: boolean;
  /**
   * Require the element to be actionable. True for click, fill and the rest;
   * false for assertions, which read headings, badges and error messages —
   * none of which is interactable, and all of which tests assert on.
   */
  readonly requireInteractable?: boolean;
  readonly maxCandidates?: number;
}

export function filterInteractable(
  candidates: readonly ElementCandidate[],
  options: FilterOptions = {},
): ElementCandidate[] {
  const {
    requireVisible = true,
    requireEnabled = true,
    requireInteractable = true,
    maxCandidates = 200,
  } = options;

  return candidates
    .filter(
      (candidate) => !requireInteractable || candidate.interactable || candidate.editable,
    )
    .filter((candidate) => !requireVisible || candidate.visible)
    .filter((candidate) => !requireEnabled || candidate.enabled)
    .slice(0, maxCandidates);
}

/**
 * Keeps candidates that could plausibly satisfy the intent.
 *
 * This is a *recall* filter, not a ranking: it errs toward keeping things. A
 * candidate wrongly dropped here can never be recovered by later scoring, so
 * the matching below is loose on purpose and the real discrimination happens
 * in the resolver.
 */
export function filterBySemantics(
  candidates: readonly ElementCandidate[],
  intent: ElementIntent,
): ElementCandidate[] {
  const role = intent.role?.toLowerCase();
  const searchText = normalize(intent.name ?? intent.description ?? '');
  const tokens = tokenize(searchText);

  const matched = candidates.filter((candidate) => {
    if (role !== undefined && candidate.role !== undefined && candidate.role !== role) {
      // A role hint that disagrees is a strong exclusion signal — but only when
      // the candidate actually has a role to compare.
      return false;
    }

    if (tokens.length === 0) return true;

    const haystack = normalize(
      [
        candidate.accessibleName,
        candidate.text,
        candidate.attributes['aria-label'],
        candidate.attributes.placeholder,
        candidate.attributes.name,
        candidate.attributes.id,
        candidate.attributes.title,
        candidate.attributes.value,
        candidate.context?.componentHint,
      ]
        .filter((value): value is string => value !== undefined)
        .join(' '),
    );

    // One shared meaningful token is enough to stay in the running.
    return tokens.some((token) => haystack.includes(token));
  });

  if (matched.length > 0) return matched;

  // Never return an empty shortlist when candidates existed: that would make the
  // resolver report "nothing on the page" when the truth is "nothing matched my
  // keywords", sending a reviewer down the wrong path.
  //
  // The fallback relaxes only the *text* match. A contradicting role stays
  // excluded, because a role hint is a deliberate statement about what kind of
  // control is wanted, not a keyword guess.
  const roleCompatible = candidates.filter(
    (candidate) =>
      role === undefined || candidate.role === undefined || candidate.role === role,
  );
  return roleCompatible.length > 0 ? roleCompatible : [...candidates];
}

/** Ranks by how well a candidate's label matches the intent text. */
export function rankByTextSimilarity(
  candidates: readonly ElementCandidate[],
  intent: ElementIntent,
): { candidate: ElementCandidate; similarity: number }[] {
  const target = normalize(intent.name ?? intent.description ?? '');
  if (target.length === 0) {
    return candidates.map((candidate) => ({ candidate, similarity: 0 }));
  }

  return candidates
    .map((candidate) => ({
      candidate,
      similarity: similarity(target, normalize(labelOf(candidate))),
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Token-overlap similarity with an exact-match shortcut.
 *
 * Chosen over edit distance because UI labels differ by whole words far more
 * often than by characters: "Login" vs "Log in" vs "Sign in Button".
 */
export function similarity(rawA: string, rawB: string): number {
  // Normalized here rather than at the call sites: this function is exported,
  // so it cannot assume its input has already been through normalize().
  const a = normalize(rawA);
  const b = normalize(rawB);

  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setB = new Set(tokensB);
  const shared = tokensA.filter((token) => setB.has(token)).length;
  const overlap = shared / Math.max(tokensA.length, tokensB.length);

  // A full substring match is strong evidence even when token counts differ,
  // e.g. intent "Login" against label "Login Button".
  const containment = b.includes(a) || a.includes(b) ? 0.3 : 0;

  return Math.min(1, overlap + containment);
}

/** Words that carry no discriminating power in UI labels. */
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

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
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
