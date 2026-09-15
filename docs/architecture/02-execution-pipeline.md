# Execution pipeline

One step, end to end:

```
preconditions  →  inspect  →  resolve  →  execute  →  observe  →  record
```

## Why re-inspect per step

A page changes as a test drives it. Resolving against a snapshot taken at the
start of the run is how automation clicks something that has since moved.

## Why failures are values

A failed step records its error and evidence in the timeline, and the loop
decides whether to continue. An exception would unwind the run and lose the
record that makes the failure reviewable.

## Assertions read; actions drive

An assertion targets headings, badges and error messages — none of which is
interactable. Assert steps therefore widen the snapshot to all visible elements
and drop the interactability requirement. Requiring it made a heading
unresolvable and pushed the resolver into a low-confidence guess at a nearby
button; that was a real bug, caught by an end-to-end run.

## Resolution, in detail

```
PageSnapshot (≈100 candidates from ≈10,000 DOM nodes)
   → filterInteractable      visible, enabled, actionable
   → filterBySemantics       role and keyword recall filter
   → rankByTextSimilarity    closest label first
   → generate                several selectors per candidate
   → score                   strategy weight + penalties + bonuses
   → validate                probe the live page: 0, 1, or many
   → ResolvedElement         confidence + evidence
```

Entirely deterministic. See `.claude/skills/runner-locator-engine/`.
