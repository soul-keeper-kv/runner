# Runner Service

An API-first browser automation runtime. It **executes submitted Test IR**; it
does not author test cases and does not generate Test IR from natural language.
That belongs to a separate service which integrates over HTTP only.

## Skills — load these before working

| Working on | Load |
|---|---|
| Where a file goes, layering, a new package or adapter | `runner-architecture` |
| `contracts/`, an HTTP route, a request/response field, an error code | `runner-contracts` |
| Element resolution, selectors, scoring, page inspection | `runner-locator-engine` |
| Registry, aliases, revisions, confidence, self-healing | `runner-registry` |
| Live commands, WebSocket, capabilities, `apps/live-web` | `runner-live-protocol` |
| Writing or debugging tests | `runner-testing` |
| Wording a commit message, splitting a working tree into commits | `git-commit` |

They are in `.claude/skills/`. Load the relevant one before writing code — the
layering here is enforced by lint, and the contract rules protect an external
service you cannot redeploy.

## Commands

```bash
pnpm install
pnpm infra:up                              # Postgres :5433, Redis :6380
pnpm --filter @runner/worker browsers:install

pnpm dev                                   # all apps
pnpm --filter @runner/api dev              # API only, :3001
pnpm --filter @runner/live-web dev         # workspace, :5173

pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm e2e                                   # real browser, needs API + worker
```

In VS Code, `.vscode/launch.json` has debug configs for each process and a
**Full stack (API + Worker)** compound. They run the TypeScript sources through
tsx, so breakpoints land in `src/` with no build step.

## Gotcha: functions sent into the page

`page.evaluate` serializes a function's *compiled* source. Under tsx, esbuild
rewrites named functions and arrows as `__name(fn, "name")`, and that helper
does not exist in the browser — so anything passed to `evaluate` throws
`ReferenceError: __name is not defined` when running from source, while working
fine from `dist/`.

`PlaywrightBrowserAdapter.ensureTranspilerHelpers()` defines the helper in the
page before every `evaluate` call. Call it from any new `evaluate` site you add.
`apps/worker/test/page-evaluate-serialization.test.ts` guards this.

The API starts without Postgres or Redis using in-memory adapters, so the
contract can be exercised before Docker is running. It warns when it does, and
refuses to start that way when `NODE_ENV=production`.

## Persistence: three tiers, in order of durability

The Registry binds to Postgres when `DATABASE_URL` is set, Redis when only
`REDIS_URL` is, and in-memory otherwise — each step down warns at startup.
Postgres is the system of record because element identity outlives every process:
Test IR references it by id, so losing it orphans previously generated tests.

`pnpm db:migrate` applies `infra/migrations` and records them in
`schema_migrations`. It adopts an already-present schema as its baseline, because
`pnpm infra:up` applies the same files on a container's first boot — re-running
them would fail with `42P07`.

## Layout

```
apps/api        Public HTTP + WebSocket. Validates, queues, reports.
apps/worker     Playwright execution. The only place browsers exist.
apps/live-web   Runner-owned live authoring UI.
packages/       Private workspace packages. Never imported by another service.
contracts/      PUBLIC OpenAPI + JSON Schema. The integration surface.
infra/          docker-compose + SQL migrations
```

## The rules that matter most

1. **Nothing outside this repo imports `packages/*`.** External services
   integrate through `contracts/` — HTTP, OpenAPI, JSON Schema, webhooks.
2. **Playwright only in `apps/worker/src/infrastructure/playwright/`.** Lint
   enforces this. Everything else depends on `BrowserPort`.
3. **Public DTOs are never domain objects.** `ExecutionRequestV1` and
   `ExecutionPlan` meet only in `packages/application/src/mappers/`.
4. **Selectors are structured data, never code.** No user JavaScript, no string
   concatenation into `page.locator()`.
5. **Test IR carries no raw selectors and no credentials.** Targets are named;
   selectors live in the Registry; credentials are referenced by profile.
6. **The API queues, the worker executes.** Never run a browser in `apps/api`.
7. **Registry changes go through a draft modification.** No direct writes.
8. **AI ranks a shortlist behind a port.** It never executes or navigates.
9. **Failures are `Result` values in the pipeline**, so they land in the
   timeline with evidence. Throw only for programmer errors.
10. **`PRECONDITION_FAILED` is not `TEST_FAILED`.** Error `kind` keeps setup
    failures from being reported as application bugs.

## Current state

All phases (0–13) are implemented: workspace, contracts, public API, queue,
Playwright adapter, page inspection, the deterministic locator engine, the
Element Registry (reads, draft-then-commit writes, revisions) behind
`RegistryPort`, live command dispatch — the API forwards a validated command over
`LiveCommandTransportPort` to the worker, which holds a browser per live session
— and the live view: `state.snapshot` returns a frame plus the bounding boxes the
workspace draws highlights from. Phases 5, 6, 9+ (auth, preconditions, picking,
recorder, healing, AI) exist as ports and stubs that return
`CAPABILITY_NOT_IMPLEMENTED` naming their phase.

The live `browser`, `selector`, `state`, `element`, `registry`, `recording` and
`auth` namespaces are registered.

A live session reaches a page that only renders for a signed-in user by naming
an execution profile: `POST /api/v1/live-sessions` takes `authProfileRef`, the
runtime applies that profile's stored session when it opens the browser, and
`auth.login` performs the login *into the browser already open* when nothing is
stored yet or the application signed the user out. `scripts/auth-demo.mjs`
demonstrates the whole path against a fixture app whose page is genuinely gated
on a session cookie.

## Auth profiles: two sources, one of them relaxes a rule

A profile can come from the worker's `RUNNER_AUTH_PROFILES`, where a credential
never leaves the environment, or from `/api/v1/auth/profiles`, where a user
manages profiles from the workspace UI. Storage wins when both define one.

The managed half **deliberately relaxes rule 5**: a credential does reach the
database, sealed with AES-256-GCM under `RUNNER_SECRET_KEY`, which is held in
the environment and never stored beside the data. What did not move:

- **A credential goes in and never comes out.** Reads answer `secretsPresent` —
  field names. `resolveForExecution` is the only method that decrypts, so an
  audit has one call site to read.
- **No unencrypted fallback.** Without the key the routes answer `501` naming
  what is missing. A deployment that forgot it must not quietly become one that
  keeps passwords readable.
- **Form fields are named, never selected.** A profile says
  `{"username":"USERNAME *"}` — an accessible name the locator engine resolves
  like any other target.
Leave a namespace unregistered until it works: an unregistered command returns
`LIVE_COMMAND_UNSUPPORTED` naming it, which tells a client developer more than a
silent no-op.

## Gotcha: the resolver's similarity floor

`filterBySemantics` deliberately falls back to the *whole* candidate list when no
keyword matches, so a failure reads as "nothing matched my keywords" rather than
"nothing on the page". That is right for diagnosis and wrong for resolution, so
`DeterministicElementResolver` applies `MIN_INTENT_SIMILARITY` (0.4, matching the
Registry's `MIN_NAME_MATCH_SIMILARITY`) before validating anything.

Do not remove that check. Without it an intent naming something absent still
resolves to whichever candidate sorted first: a mistyped target clicks an
unrelated control, and an `elementVisible` precondition for a nonexistent
element reports itself *satisfied*. Only a real browser run revealed it —
typecheck and every unit test passed.

## Gotcha: two page scripts must agree

`point-pick-script.ts` duplicates `implicitRole` and `accessibleName` from
`dom-inspector-script.ts`, because a function sent through `page.evaluate`
cannot import anything. When you change one, change both —
`apps/worker/test/point-pick-parity.test.ts` fails if they drift. A divergence
here is quiet and expensive: it once made a picked email input report its
placeholder where the inspector reported its label, which cost the element its
`role=textbox` selector.

See `.claude/skills/runner-architecture/references/phases.md` for the table, and
update it when a phase lands.
