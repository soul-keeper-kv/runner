# ADR 0001 — Selectors are structured data, not code

**Status:** Accepted

## Context

The Registry must store how to find an element, and the live workspace must let
a user edit that. The obvious approach — storing a Playwright expression as a
string — makes the editor an arbitrary-code-execution path into the worker, and
ties every stored selector to one automation engine.

## Decision

A selector is a tagged union (`SelectorDefinition`) validated before use and
translated to typed Playwright calls by a single adapter.

## Consequences

- The selector editor cannot inject executable code; the union has no branch
  that reaches `eval` or a selector-engine expression.
- Selectors can be stored, diffed, scored, and shown in a review UI.
- A Selenium or Appium adapter reimplements one translator, nothing else.
- Cost: an expressive Playwright selector may need a new union variant, which
  touches the DSL, the translator, the generator and the schema.
