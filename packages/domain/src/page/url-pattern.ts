/**
 * URL pattern matching (blueprint sections 19 and 21).
 *
 * The public contract documents `urlPattern` as "a URL glob or pattern", and
 * both forms are in real use: a person writing Test IR reaches for
 * `/orders/*&#47;review`, while a generated pattern is often a regex. Supporting
 * one and silently failing the other would make a precondition that looks
 * correct never hold.
 *
 * It lives in the domain rather than in the worker because the Registry's
 * `urlPatterns` — how a stored page is recognized again — needs the identical
 * rule. Two matchers that disagree would let an element be "available on this
 * page" by one definition and not the other.
 */

/** Wrapped in slashes, e.g. `/^\/orders\/\d+$/i`, it is treated as a regex. */
function asRegexLiteral(pattern: string): RegExp | undefined {
  const match = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
  if (match === null) return undefined;

  const [, source, flags] = match;
  if (source === undefined) return undefined;

  try {
    return new RegExp(source, flags);
  } catch {
    // A malformed literal is treated as a plain glob rather than throwing: the
    // caller gets "did not match", which is a precondition failure it can act
    // on, not a crash mid-run.
    return undefined;
  }
}

/**
 * Converts a glob to an anchored regex.
 *
 * `*` matches within a path segment, `**` across segments, and `?` a single
 * character. Everything else is escaped, so a query string or a dot in a host
 * cannot accidentally become a metacharacter.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;

    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
        continue;
      }
      // A single star stops at a separator, so `/orders/*` does not swallow
      // `/orders/1/review`.
      source += '[^/?#]*';
      continue;
    }

    if (char === '?') {
      source += '[^/?#]';
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${source}$`, 'i');
}

/**
 * Does `url` satisfy `pattern`?
 *
 * Matching is attempted three ways, most explicit first: a regex literal, then
 * a glob against the whole URL, then a glob against path-and-query alone — the
 * last because `/checkout/*` is what a person means, and requiring them to
 * write the scheme and host would make every pattern environment-specific.
 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  if (pattern.length === 0) return false;

  const literal = asRegexLiteral(pattern);
  if (literal !== undefined) return literal.test(url);

  const glob = globToRegExp(pattern);
  if (glob.test(url)) return true;

  const relative = pathAndQueryOf(url);
  return relative === undefined ? false : glob.test(relative);
}

/** True when any pattern matches; an empty list matches nothing. */
export function urlMatchesAny(url: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => urlMatchesPattern(url, pattern));
}

/** `https://app.test/orders/1?x=2#top` -> `/orders/1?x=2` */
export function pathAndQueryOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    // Not an absolute URL; it is already a path.
    return url.startsWith('/') ? url : undefined;
  }
}
