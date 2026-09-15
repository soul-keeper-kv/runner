---
name: runner-locator-engine
description: How element resolution works and how to change it safely — page snapshots, candidate filtering, selector generation, scoring weights, validation and confidence. Load before editing anything under apps/worker/src/modules (locator, resolver, inspector), before adding a selector strategy or scoring rule, or when debugging why the Runner picked the wrong element or reported ELEMENT_NOT_FOUND.
---

# The locator engine

This is where the Runner decides *which element on the page* a step means. It is
deterministic, explainable and entirely free of AI — by design, not by
limitation (blueprint section 3.5).

## The pipeline

```
PageSnapshot (≈100 candidates from ≈10,000 DOM nodes)
   → filterInteractable      visible, enabled, actionable
   → filterBySemantics       role and keyword recall filter
   → rankByTextSimilarity    closest label first
   → generate                every reasonable selector per candidate
   → score                   strategy weight + penalties + bonuses
   → validate                probe the live page: 0, 1, or many matches
   → ResolvedElement         with confidence and evidence
```

Each stage narrows. The order matters: filtering before generating keeps the
work proportional to *plausible* candidates, and validating last means the
score reflects what the page actually contains.

## Files

| File | Responsibility |
|---|---|
| `infrastructure/playwright/dom-inspector-script.ts` | Runs in the page; returns JSON, never HTML |
| `modules/inspector/candidate-filter.ts` | Narrowing and text similarity |
| `modules/locator/locator-generator.ts` | Selector generation per candidate |
| `modules/locator/locator-scorer.ts` | Contextual scoring |
| `modules/locator/locator-validator.ts` | Live probing; 0 / 1 / many |
| `modules/resolver/element-resolver.ts` | Orchestrates all of the above |
| `packages/selector-model/` | The DSL, weights and heuristics |

## Scoring weights

Base scores live in `SELECTOR_BASE_SCORES`
(`packages/selector-model/src/selector-scoring.ts`):

```
testId 100 · role 95 · label 90 · placeholder 85 · altText 80
text 75 · title 70 · css 60 · xpath 30
```

Penalties: `dynamicId -40`, `nthChild -50`, `generatedClass -30`,
`nonUnique -50`, `veryLongSelector -20`, `positionalXPath -35`.

Bonuses: `userConfirmed +40`, `historicallyStable +20`,
`matchedExpectedComponent +15`, `matchedExpectedPage +10`.

The ordering encodes one idea: **prefer what a human put there on purpose.** A
`data-testid` exists for testing; a hashed class name exists for a bundler. The
`nonUnique` penalty is deliberately heavy because acting on the first of several
matches is how automation clicks the wrong table row.

## Changing a weight

Weights are data, and the tests in
`packages/selector-model/test/selector-model.test.ts` assert *relationships*
(test id beats role beats css beats xpath), not exact numbers. Keep it that way:
a test asserting `score === 87` breaks on every tuning pass and teaches nothing.

If you change a weight, state why in the commit — the numbers are a hypothesis
about which selectors survive real UI churn.

## Adding a selector strategy

1. Add the variant to `SelectorDefinition` in `packages/selector-model`.
2. Add a base score to `SELECTOR_BASE_SCORES` (exhaustiveness will force this).
3. Handle it in `describeSelector()`.
4. Handle it in **both** `applySelector` and `applySelectorToLocator` in
   `apps/worker/src/infrastructure/playwright/selector-translator.ts`.
5. Emit it where appropriate in `locator-generator.ts`.
6. Add it to the `selectorStrategies` enum in the JSON Schema and OpenAPI.

TypeScript's exhaustive switches will point at 3 and 4 if you miss them.

## Why generation always returns several selectors

Never rely on one. A registry entry keeps a primary plus ranked fallbacks so
that when a `data-testid` is renamed, the role-and-name selector underneath it
still resolves — and healing has real alternatives to propose rather than
guessing. If `generate()` returns one selector for an element with several
signals, that is a bug.

## Debugging a wrong or missing element

**`ELEMENT_NOT_FOUND`.** The error's `details.attempts` lists each selector tried
and why it failed. Read it first. Common causes:

- the element genuinely is not there yet → a *precondition* problem, not a
  selector problem; check whether the step needs a preceding action
- it is inside an iframe → snapshot frames, scope the selector
- `filterBySemantics` dropped it → check whether the `role` hint contradicts the
  element's actual role

**Wrong element chosen.** Look at `evidence` in the result. It names the
similarity score and the winning selector. Usually either two elements share a
label (add `componentId` or a `description`) or the intent text is too generic.

**`ELEMENT_AMBIGUOUS`.** The selector matched several elements. This is the
engine working correctly — it refuses to guess. Scope the intent to a component
or give the element a test id.

## Similarity matching

`similarity()` uses token overlap, not edit distance, because UI labels differ
by whole words far more often than by characters: "Login" vs "Log in" vs
"Sign in Button". It normalizes case, punctuation and diacritics itself — it is
exported, so it cannot assume the caller normalized first.

Stop words (`button`, `field`, `input`, `link`, `icon`, `the`, `a`…) are dropped
because they appear in almost every label and discriminate nothing. If every
token is a stop word, the original tokens are used — "Button" alone is a
legitimate query.

## Confidence

```
confidence = selectorScore/100 × 0.6 + textSimilarity × 0.4
```

Both matter and neither is sufficient: a perfect `data-testid` pointing at the
wrong element is still wrong, and an exact name match through a positional
XPath is still fragile.

Confidence drives the AUTO / REVIEW / WAITING_USER decision through
`decideByConfidence()` in `packages/registry-model`. Thresholds: `≥ 0.95`
execute, `0.70–0.95` warn or pause depending on mode, `< 0.70` always wait.

## The recall-filter rule

`filterBySemantics` errs toward keeping candidates: a candidate wrongly dropped
there can never be recovered by later scoring. It returns a role-compatible
fallback rather than an empty list, so the resolver never reports "nothing on
the page" when the truth is "nothing matched my keywords".

Note the asymmetry, which is intentional: the fallback relaxes the *text* match
but keeps the *role* exclusion. A role hint is a deliberate statement about what
kind of control is wanted, not a keyword guess.

## Before adding AI here

Don't, yet. `SemanticResolverPort` exists for Phase 13 and receives a shortlist
of roughly ten candidates — never a page. If deterministic resolution is failing
often enough that AI looks like the fix, the bug is usually in filtering or
scoring. Fix that first: a model's answer cannot be explained to a reviewer the
way an evidence chain can.

## Tests

`apps/worker/test/locator-engine.test.ts` covers generation, scoring and
filtering with no browser. Add cases there before touching the browser path —
two real bugs (an unnormalized `similarity()` and a fallback that resurrected
role-excluded candidates) were caught by exactly these tests.
