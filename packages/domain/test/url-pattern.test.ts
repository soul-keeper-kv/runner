import { describe, expect, it } from 'vitest';
import { globToRegExp, pathAndQueryOf, urlMatchesAny, urlMatchesPattern } from '../src/index.js';

/**
 * The contract calls `urlPattern` "a URL glob or pattern", and both forms are in
 * real use. These tests pin that both work and that a single `*` does not
 * silently swallow path segments — a pattern that matches more than the author
 * meant makes a precondition hold when it should not.
 */

describe('glob patterns', () => {
  it('matches a full URL', () => {
    expect(urlMatchesPattern('https://app.test/orders', 'https://app.test/orders')).toBe(true);
  });

  it('matches a path-only pattern, so a pattern is not environment-specific', () => {
    // Requiring the scheme and host would make every pattern break between
    // staging and production.
    expect(urlMatchesPattern('https://app.test/checkout/review', '/checkout/review')).toBe(true);
  });

  it('treats a single star as within one segment', () => {
    expect(urlMatchesPattern('https://app.test/orders/42', '/orders/*')).toBe(true);
    // The dangerous case: `/orders/*` must not match a deeper path.
    expect(urlMatchesPattern('https://app.test/orders/42/review', '/orders/*')).toBe(false);
  });

  it('treats a double star as crossing segments', () => {
    expect(urlMatchesPattern('https://app.test/orders/42/review', '/orders/**')).toBe(true);
  });

  it('matches a single character with ?', () => {
    expect(urlMatchesPattern('https://app.test/v1/orders', '/v?/orders')).toBe(true);
    expect(urlMatchesPattern('https://app.test/v12/orders', '/v?/orders')).toBe(false);
  });

  it('is case-insensitive, as hosts and most routes are', () => {
    expect(urlMatchesPattern('https://APP.test/Orders', 'https://app.test/orders')).toBe(true);
  });

  it('escapes regex metacharacters in a glob', () => {
    // A dot must match a dot, not any character.
    expect(urlMatchesPattern('https://app.test/a', 'https://app.test/a')).toBe(true);
    expect(urlMatchesPattern('https://appXtest/a', 'https://app.test/a')).toBe(false);
  });

  it('treats ? in a glob as a wildcard, not as a literal query separator', () => {
    /*
     * A real limitation worth stating rather than hiding: in glob form `?` is
     * the single-character wildcard, so `/s?q=1` cannot match the literal
     * `/s?q=1`. A pattern author who needs a query string reaches for `**` or a
     * regex literal, both shown below.
     */
    expect(urlMatchesPattern('https://app.test/s?q=1', '/s?q=1')).toBe(false);
    // As a wildcard it does match a same-length path.
    expect(urlMatchesPattern('https://app.test/sxq=1', '/s?q=1')).toBe(true);
  });

  it('matches a query string through ** or a regex literal', () => {
    expect(urlMatchesPattern('https://app.test/s?q=1', '/s**')).toBe(true);
    expect(urlMatchesPattern('https://app.test/s?q=1', '/\\/s\\?q=1$/')).toBe(true);
  });

  it('anchors the pattern, so a prefix is not a match', () => {
    expect(urlMatchesPattern('https://app.test/orders/42', '/orders')).toBe(false);
  });
});

describe('regex literals', () => {
  it('accepts a slash-wrapped literal', () => {
    expect(urlMatchesPattern('https://app.test/orders/42', '/\\/orders\\/\\d+$/')).toBe(true);
    expect(urlMatchesPattern('https://app.test/orders/abc', '/\\/orders\\/\\d+$/')).toBe(false);
  });

  it('honours literal flags', () => {
    expect(urlMatchesPattern('https://app.test/ORDERS', '/orders/i')).toBe(true);
    expect(urlMatchesPattern('https://app.test/ORDERS', '/orders/')).toBe(false);
  });

  it('falls back to glob matching for a malformed literal rather than throwing', () => {
    // A crash mid-run would be worse than a precondition that reports unmet.
    expect(() => urlMatchesPattern('https://app.test/x', '/[unclosed/')).not.toThrow();
  });
});

describe('edge cases', () => {
  it('never matches an empty pattern', () => {
    expect(urlMatchesPattern('https://app.test/', '')).toBe(false);
  });

  it('matches any of several patterns', () => {
    const patterns = ['/login', '/signin'];
    expect(urlMatchesAny('https://app.test/signin', patterns)).toBe(true);
    expect(urlMatchesAny('https://app.test/dashboard', patterns)).toBe(false);
  });

  it('matches nothing when no patterns are given', () => {
    expect(urlMatchesAny('https://app.test/', [])).toBe(false);
  });

  it('extracts path and query, dropping the fragment', () => {
    expect(pathAndQueryOf('https://app.test/orders/1?x=2#top')).toBe('/orders/1?x=2');
  });

  it('treats an already-relative value as its own path', () => {
    expect(pathAndQueryOf('/orders/1')).toBe('/orders/1');
  });

  it('builds an anchored, case-insensitive regex from a glob', () => {
    const regex = globToRegExp('/a/*');
    expect(regex.source.startsWith('^')).toBe(true);
    expect(regex.source.endsWith('$')).toBe(true);
    expect(regex.flags).toContain('i');
  });
});
