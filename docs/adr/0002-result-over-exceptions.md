# ADR 0002 — `Result` for expected failures

**Status:** Accepted

## Context

Most Runner failures are not bugs: a selector matches nothing, a precondition
cannot be prepared, an assertion fails. Each must appear in the execution
timeline with its evidence so a human can review it.

## Decision

Pipeline operations return `Result<T, RunnerError>`. Exceptions are reserved for
programmer errors and for composition-root boundaries, where `unwrapOrThrow`
converts a failure into an HTTP response.

## Consequences

- A failure carries a code, a `kind`, and details across process boundaries.
- The timeline entry is written by the code that understands the failure, not
  by whatever `catch` happens to be nearest.
- Cost: more explicit `if (!result.ok) return result;` at call sites. Accepted:
  it is also a visible reminder of every branch that can fail.
