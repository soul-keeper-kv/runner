# ADR 0005 — The API and the worker are separate processes

**Status:** Accepted

## Context

Browsers hang, crash and leak memory. The public API must stay responsive
regardless, because callers poll it for results and integrate against it.

## Decision

`apps/api` validates, persists and enqueues, then returns `202`. `apps/worker`
consumes the queue and drives Playwright. They share an `ExecutionStorePort`
implementation so both see one execution state, and nothing else.

## Consequences

- A crashed browser affects only in-flight executions.
- Workers scale independently of API instances.
- The store must be shared: an in-memory store in the API with a Redis-backed
  worker enqueues jobs that can never find their plan. That was a real bug,
  found the first time both processes ran together.
- Cost: local development needs Redis for a working end-to-end setup. The API
  still starts without it, and says so.
