import type { RunnerError } from '../errors/runner-error.js';

/**
 * A serializable success/failure union.
 *
 * The Runner pipeline has many partially-failing steps (a selector that matches
 * nothing, a precondition that cannot be prepared). Modelling those as values
 * rather than thrown exceptions keeps them representable in the execution
 * timeline and across the worker/API boundary.
 *
 * Exceptions remain reserved for genuine programmer errors.
 */
export type Result<T, E = RunnerError> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Applies `fn` to a success value, leaving failures untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Chains a fallible step onto a success value. */
export function flatMapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** Extracts the value, or returns `fallback` for a failure. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Extracts the value or throws. Use only at a boundary that has already
 * decided a failure is unrecoverable — never inside pipeline logic.
 */
export function unwrapOrThrow<T>(result: Result<T, RunnerError>): T {
  if (result.ok) return result.value;
  throw result.error;
}

/** Collects a list of results, short-circuiting on the first failure. */
export function collectResults<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
