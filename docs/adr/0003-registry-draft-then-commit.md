# ADR 0003 — Every Registry change is a draft first

**Status:** Accepted

## Context

The Registry is edited by users in a live session and by automated healing. A
silently rewritten selector — especially a human-confirmed one — destroys trust
in the Registry exactly when it matters most.

## Decision

No code writes a Registry entity directly. A change becomes a
`RegistryModification` with explicit `before`/`after`, moves through
`DRAFT → PROPOSED → CONFIRMED | REJECTED`, and only a confirmation writes a
`RegistryRevision`. Decided states are terminal.

`RegistryPort` deliberately exposes no blind `update()`.

## Consequences

- Undo, diff, revision history and approval workflows become possible without
  a redesign.
- Self-healing proposes rather than mutates; AUTO mode may commit under policy.
- Cost: two steps to change an element, and confirmation must apply the change
  and write the revision in one transaction.
