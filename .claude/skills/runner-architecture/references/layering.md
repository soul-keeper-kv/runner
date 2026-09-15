# Layering, with worked examples

## The dependency rule

Dependencies point inward. An inner layer never knows about an outer one.

```
infrastructure  →  application  →  domain
(Playwright,       (use cases,      (pure types,
 Postgres,          ports,           no imports)
 Nest, Redis)       mappers)
```

Inversion is how an inner layer "uses" an outer one: the application layer
declares `BrowserPort`, and infrastructure implements it. The arrow of
*dependency* still points inward even though the arrow of *control* points out.

## Worked example: adding screenshot capture to a step

The wrong instinct is to reach for Playwright where the need appears.

```ts
// ✗ apps/worker/src/application/use-cases/run-execution.ts
import { chromium } from 'playwright';          // forbidden, and lint fails
const buffer = await page.screenshot();
```

The right shape already exists: `BrowserPort.screenshot()` and
`ArtifactStoragePort.put()`.

```ts
// ✓ same file
const shot = await browser.screenshot({ fullPage: false });
if (shot.ok) {
  const stored = await deps.artifacts.put({
    kind: 'screenshot',
    contentType: 'image/png',
    data: shot.value,
    executionId: context.executionId,
    stepId: action.id,
  });
  if (stored.ok) artifactIds.push(stored.value.id);
}
```

The use case now works unchanged against Playwright today and Selenium later,
and against local disk today and S3 later.

## Worked example: a public field that is not a domain field

A caller asks for `retryCount` on a step.

1. Add it to `contracts/json-schema/test-ir-v1.schema.json` and to
   `TestActionV1` in `packages/test-ir-model`. This is the promise to callers.
2. Decide what the *pipeline* needs. Perhaps it needs `maxAttempts: number`
   with a default, which is not the same shape. Add that to `TestAction` in
   `packages/domain`.
3. Translate in `mapAction()` — the only place both types are visible.

Skipping step 2 and reusing `TestActionV1` inside the worker is the mistake the
mapper exists to prevent: the public contract would then be unable to evolve
without touching browser code.

## Why `Result` instead of exceptions

Compare the two failure modes a resolver has:

- The selector matched nothing. This is *expected*: the page may not be in the
  right state. It belongs in the timeline, with evidence, so a human can review
  it. → `Result`.
- `deps.resolver` is `undefined` because wiring is wrong. This is a bug, and
  there is no sensible recovery. → throw.

Using exceptions for the first case means the timeline entry is written by
whatever `catch` happens to be nearest, losing the evidence chain that makes
REVIEW mode useful.

## Where the boundary actually is in each app

**apps/api** — `presentation/` knows Nest and Fastify; `application/` (the
imported use cases) knows neither; `infrastructure/` knows Redis, Postgres and
BullMQ. The `container.ts` composition root is the only file that names a
concrete adapter class.

**apps/worker** — `modules/` holds pipeline logic and depends on ports;
`capabilities/` handles live commands and depends on ports; only
`infrastructure/playwright/` imports Playwright. `main.ts` is the composition
root.

**apps/live-web** — `lib/` holds the HTTP and WebSocket clients; `features/`
holds UI; `stores/` holds state. It imports `@runner/live-protocol` and
`@runner/selector-model` for types, and nothing else from the workspace.

## Testing follows the same shape

Because the pipeline depends on ports, a test can drive it with a fake:

```ts
const browser: BrowserPort = {
  sessionId: 'bs_test',
  probe: async () => ok({ matchCount: 1, visible: true, enabled: true, editable: false }),
  // …only what the test exercises
} as BrowserPort;
```

No browser is launched, and the test stays fast enough to run on every change.
That is the practical payoff of the layering, and the reason scoring and
resolution logic must not reach for Playwright directly.
