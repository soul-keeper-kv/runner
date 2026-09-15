# ADR 0004 — Deterministic resolution before AI

**Status:** Accepted

## Context

The tempting design is: send the page to a model, ask which element to click.
It is quick to demonstrate and hard to operate — non-reproducible, expensive
per step, and unable to explain a wrong answer to a reviewer.

## Decision

Resolution is deterministic: filter, rank, generate, score, validate. AI sits
behind `SemanticResolverPort`, receives a shortlist of roughly ten candidates,
and only ranks. It never executes, navigates, or writes to the Registry.

## Consequences

- Every resolution is reproducible and carries evidence a human can read.
- Resolution runs with no model, no API key and no per-step cost.
- Scoring and filtering are unit-testable without a browser — which is how two
  real bugs were caught before they reached a page.
- Cost: genuinely ambiguous semantic targets wait for Phase 13.
