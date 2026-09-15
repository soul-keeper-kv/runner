---
name: runner-testing
description: How to test the Runner — what deserves a test, how to fake ports without a browser, and the commands to run. Load before writing tests, when a test fails and the cause is unclear, or when adding logic to scoring, resolution, mapping, the Registry or the contracts.
---

# Testing the Runner

## What deserves a test

Test **decision logic** — the code that chooses, ranks, validates or rejects.
That is where bugs are silent and expensive.

| Worth testing | Why |
|---|---|
| Selector scoring and heuristics | Silent wrong ranking → wrong element clicked |
| Candidate filtering and similarity | Silent recall loss → `ELEMENT_NOT_FOUND` |
| The inbound mapper | The public boundary; must reject bad input precisely |
| JSON Schema behaviour | Callers depend on exactly these rejections |
| Confidence and mode policy | Decides whether a human is asked |
| Registry modification transitions | Protects auditability |
| Error `kind` mapping | Setup failures must not read as test failures |

Not worth testing: adapters that only translate a call (the Playwright adapter,
the console logger), framework wiring, and barrel exports.

Blueprint rule 14 is explicit — tests around locator scoring and Registry
resolution come *before* AI. Two real bugs in this repository were caught by
exactly those tests: `similarity()` not normalizing its own input, and a recall
fallback that resurrected candidates a role hint had excluded.

## Commands

```bash
pnpm test                                  # everything
pnpm --filter @runner/selector-model test  # one package
pnpm --filter @runner/worker test          # locator engine
pnpm --filter @runner/worker test:watch    # watch mode
```

## Testing against ports, not implementations

The layering pays off here: a fake is a literal.

```ts
import { ok } from '@runner/shared';
import type { BrowserPort } from '@runner/application';

const browser = {
  sessionId: 'bs_test',
  probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: false }),
} as unknown as BrowserPort;
```

Implement only the methods the test exercises. No browser launches, so the suite
stays fast enough to run on every change.

Time is injected too:

```ts
import { fixedClock } from '@runner/shared';
const clock = fixedClock('2026-01-01T00:00:00.000Z');
clock.advance(1500);
```

## Assert relationships, not magic numbers

```ts
// ✗ breaks on every tuning pass, teaches nothing
expect(scored.score).toBe(87);

// ✓ states the rule the code exists to implement
expect(testIdScore).toBeGreaterThan(roleScore);
expect(ambiguous.score).toBeLessThan(unique.score);
```

Weights are a hypothesis about which selectors survive UI churn. Tests should
pin the *ordering* they encode, not the current guess.

## Narrowing a Result in a test

```ts
const result = mapExecutionRequest({ request, executionId: 'run_1' });
expect(result.ok).toBe(true);
if (!result.ok) return;              // narrows the union
expect(result.value.actions).toHaveLength(2);
```

For failures, assert the **code**, not the message — messages are for humans and
will be reworded:

```ts
expect(result.error.code).toBe('CONTRACT_VERSION_UNSUPPORTED');
expect(result.error.details).toMatchObject({ received: 'runner.execution.v2' });
```

## Contract tests

`packages/contracts-internal/test/` validates against the **published schema
files**, not a TypeScript copy. That is what keeps the three places a contract
lives from drifting apart.

Two cases matter most, because they protect architectural decisions rather than
code paths:

```ts
it('rejects a raw selector, which belongs in the Registry', () => { … });
it('requires a profile on an authenticated precondition', () => { … });
```

## Manual verification

```bash
pnpm infra:up
pnpm --filter @runner/api dev

curl -s localhost:3001/health
curl -s localhost:3001/api/v1/capabilities | jq .contracts
curl -s -X POST localhost:3001/api/v1/validate/test-ir \
  -H 'content-type: application/json' -d @ir.json
```

Worth checking by hand after changing the API: a `202` with a `Location` header,
a repeated `Idempotency-Key` returning the same `executionId`, a `404` carrying
a structured error, and a `501` from an unimplemented Registry route.

## The source-vs-dist trap

Some bugs exist only when the worker runs from TypeScript source. The known
one: `page.evaluate` serializes a function's *compiled* source, and esbuild
(which tsx uses) rewrites functions as `__name(fn, "name")` — a helper the
browser does not have. Running from `dist/` hides it completely.

So a green `pnpm test` and a working `node dist/main.js` do **not** prove
`pnpm dev` works. After touching anything that crosses into the page, run
`pnpm e2e` with the processes started from source, as the VS Code launch
configs do.

`apps/worker/test/page-evaluate-serialization.test.ts` guards this specific
case without a browser.

## Browser-level tests

Phase 1+ features need a real page. Keep them separate from unit tests — they
are slower and need `pnpm --filter @runner/worker browsers:install`. Prefer a
local fixture page over a public site: a third-party page that changes turns
into a flaky test that blames your code.

## Before opening a PR

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`lint` enforces the architecture boundaries, so a lint failure there is usually
a design problem rather than a formatting one — read the rule's message before
reaching for a disable comment.
