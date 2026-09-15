/**
 * Time as an injected dependency.
 *
 * Timeline ordering, session expiry and selector history all depend on time;
 * injecting it keeps those testable without sleeping in tests.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** ISO-8601 timestamp, the format used in every wire contract. */
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/** A controllable clock for tests. */
export function fixedClock(startIso: string): Clock & { advance(ms: number): void } {
  let current = new Date(startIso).getTime();
  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
