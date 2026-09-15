---
name: runner-registry
description: The Element/Page/Component Registry — stable ids, display names, aliases, selector history, draft modifications, revisions and confidence. Load before touching packages/registry-model, the registry modules, registry API routes or the registry tables, and before implementing Phase 4, Phase 10 or self-healing.
---

# The Registry

The Registry is a **semantic knowledge base**, not an object repository. That
distinction drives every design decision below.

An object repository stores "this element is at `#btn-submit`". The Registry
stores what the element *means* ("Create Customer Button — creates a new
customer from the form"), what people have called it, how it has been found
before, when it is available, and whether a human confirmed it. The selector is
one replaceable fact among those, which is what makes healing possible without
making the Registry untrustworthy.

## Three separable things per element

```
identity   id                    immutable, referenced by Test IR
meaning    displayName           what humans call it
           description           what it does
           aliases[]             everything else it answers to
           semanticType, role
mechanics  primarySelector       how to find it today
           fallbackSelectors[]   how else to find it
           selectorHistory[]      how it used to be found
```

Keeping them separate is why a selector can heal without touching meaning, and a
name can change without touching mechanics.

## The rules

**1. `id` is immutable.** Test IR references it. Renaming "Create Customer
Button" to "Save New Customer" must not break a single existing test. If you
find code that regenerates ids, that is a bug.

**2. A `USER` name outranks an `AI` name.** `displayNameSource` records which.
An AI-suggested name must never overwrite a user-authored one; the correct move
is to add an alias.

**3. Every change is a draft first.** Nothing writes an element directly.
A change becomes a `RegistryModification` carrying explicit `before` and `after`,
moves `DRAFT → PROPOSED → CONFIRMED | REJECTED`, and only a confirmation writes
a `RegistryRevision`. `CONFIRMED` and `REJECTED` are terminal — history is never
rewritten.

This single rule is what makes undo, diff, approval workflows and auditable
self-healing possible later without redesigning the store. A direct update path
added "just for imports" removes all of it permanently.

**4. Healing proposes; it does not mutate.** `HealingEngine` produces a
modification with `proposedBy: 'HEALING'`. AUTO mode may commit it above
`autoHealThreshold` (0.97); REVIEW mode shows it to a human. A silently rewritten
confirmed selector is the failure mode that destroys trust in the Registry.

**5. `systemName` is generated, never user text.** Code generation uses it as an
identifier. `toSystemName()` in `packages/shared` normalizes: "Create Customer
Button" → `createCustomerButton`, and a leading digit is prefixed so the result
is a valid identifier.

## Resolution order

```
elementId  >  displayName  >  alias  >  description  >  systemName  >  DOM discovery
```

Strongest first, and the reasons are worth remembering: a stable id survives
renames; a user-defined name is a current human decision; an alias is a past or
suggested one; everything registry-backed beats fresh DOM discovery because the
Registry carries confirmation history that a new page does not.

## Confidence

`computeElementConfidence()` in `packages/registry-model` folds four signals:

```
base    = selectorScore / 100
history = (successes + 1) / (attempts + 2)      Laplace smoothing
score   = base × 0.6 + history × 0.4
confirmed → max(score, 0.96)
```

Two deliberate choices. Laplace smoothing stops a single early success reading
as certainty — one pass is weak evidence. And a human confirmation dominates,
because a person looking at the real page is better evidence than any heuristic.

## Aliases

Learn them from: user corrections, AI suggestions, observed UI text, and
historical names. When a user resolves an ambiguous query — they searched
"customer submit button" and picked "Create Customer Button" — store the phrase
as an alias. That is the human-in-the-loop learning loop (blueprint section 41),
and it is why the same query resolves automatically next time.

## Availability conditions

`availableWhen` records *when* an element exists:

```json
{ "availableWhen": [
  { "type": "uiState", "value": "ORDER_REVIEW_OPEN" },
  { "type": "role", "value": "ROLE_MANAGER" }
] }
```

This is what separates two failures the Runner must never conflate:

- **selector healing** — the element exists, its selector changed
- **state resolution** — the element does not exist yet, because the app is not
  in the state that produces it

Conflating them produces a Runner that "heals" its way to the wrong element.

## Schema

Tables: `elements`, `element_aliases`, `element_selectors`, `pages`,
`components`, `registry_modifications`, `registry_revisions`
(`infra/migrations/0001_initial_schema.sql`).

Selectors are JSONB, not normalized columns — they are a tagged union that will
grow strategies, and querying inside one is rare compared with reading it whole.

Indexes worth knowing: `elements_display_name_idx` is case-insensitive on
`(workspace_ref, lower(display_name))` because name lookup is a primary
resolution path, and `elements_system_name_idx` is unique per workspace because
generated code needs unique identifiers.

## Implementing Phase 4

1. Implement `RegistryPort` against Postgres in `apps/api/src/infrastructure/persistence`.
2. Note the port has **no** blind `update()` — that is deliberate. Go through
   `proposeModification` and `confirmModification`.
3. `confirmModification` must apply the change and write the revision in one
   transaction; a committed change without its revision is an unauditable one.
4. Wire `RegistryService.findByIntent` into `DeterministicElementResolver` ahead
   of DOM discovery.
5. Replace the `501` stubs in `apps/api/src/presentation/http/v1/registry/`.
6. Flip `registry.elements` to `AVAILABLE` in `capabilities.ts`.
