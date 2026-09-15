---
name: runner-architecture
description: Source structure and layering rules for the Runner Service. Load before adding a file, a module, a package, or a dependency — it says which layer owns what, where a new file belongs, and which imports are forbidden. Use when deciding where code goes, when a build fails on an import boundary, or when adding a new adapter, port, capability or app.
---

# Runner Service architecture

The Runner is **one standalone, API-first service**. It executes submitted Test
IR. It does not author test cases and does not generate Test IR from natural
language — that is a separate service which integrates over HTTP only.

Read this before creating any file. Where a file goes is not a style question
here: the layering is load-bearing, and lint enforces most of it.

## The one-paragraph version

Business rules live in `packages/domain` and depend on nothing. Use cases live
in `packages/application` and depend only on domain plus *ports* (interfaces).
Adapters implement those ports in `infrastructure/` folders and are the only
code allowed to touch Playwright, Postgres, Redis or Nest. Public wire contracts
live in `contracts/` and are versioned separately from internal models. Nothing
outside the repo may import any `packages/*`.

## Repository map

```
runner-service/
├── apps/
│   ├── api/        Public HTTP + WebSocket API. Validates, queues, reports.
│   ├── worker/     Playwright execution. The only place browsers exist.
│   └── live-web/   Runner-owned live authoring UI. Not the SaaS frontend.
├── packages/       Private. Never imported by another service.
│   ├── shared/             Result, RunnerError, ids, clock, logger
│   ├── selector-model/     Structured selector DSL + scoring weights
│   ├── test-ir-model/      Public Test IR + execution wire contracts
│   ├── registry-model/     Element/Page/Component + revisions + confidence
│   ├── live-protocol/      Typed live command/event protocol
│   ├── domain/             Internal models (ElementCandidate, PageSnapshot…)
│   ├── application/        Ports, use cases, inbound/outbound mappers
│   └── contracts-internal/ JSON Schema validation + capability descriptor
├── contracts/      PUBLIC. OpenAPI + JSON Schema. The integration surface.
├── infra/          docker-compose + SQL migrations
└── docs/           architecture notes and ADRs
```

## Where does my code go?

| You are adding… | It belongs in |
|---|---|
| A pure type with no behaviour, used across layers | `packages/domain` |
| A new use case (a verb: run, resolve, confirm) | `packages/application/use-cases` |
| An interface the core needs an implementation of | `packages/application/ports` |
| Anything importing Playwright | `apps/worker/src/infrastructure/playwright` |
| Anything importing Postgres/Redis/BullMQ | an `infrastructure/` folder |
| An HTTP route | `apps/api/src/presentation/http/v1/<area>` |
| A live command handler | `apps/worker/src/capabilities/<namespace>` |
| Browser-facing pipeline logic (resolve, score, inspect) | `apps/worker/src/modules/<area>` |
| A field on a public request/response | `contracts/` **and** `packages/test-ir-model` |
| A React component | `apps/live-web/src/features/<feature>` |

If the answer is not obvious, ask: *does this know how something is done, or
what must be true?* "How" is infrastructure; "what" is domain or application.

## The rules lint enforces

These are in `eslint.config.js`, not just prose. A violation fails the build.

1. `packages/domain` and `packages/application` must not import Playwright,
   Drizzle, `pg`, `ioredis`, `bullmq`, or `@nestjs/*`.
2. `apps/worker/src/capabilities/**` must not import Playwright — capabilities
   orchestrate through `BrowserPort`.
3. `apps/live-web` must not import `@runner/domain` — the UI consumes the public
   protocol (`@runner/live-protocol`), never internal models.
4. The wire-model packages (`test-ir-model`, `selector-model`, `registry-model`,
   `live-protocol`) must not import `@runner/domain` or `@runner/application`.

## The five rules lint cannot enforce

**1. Public DTOs are never used as domain objects.**
`ExecutionRequestV1` is a wire format the Runner must keep stable for external
callers. `ExecutionPlan` is what the pipeline finds convenient. They meet in
exactly one place — `packages/application/src/mappers/`. A `*V1` type appearing
inside `apps/worker/src/modules/` is a bug.

**2. The API queues; the worker executes.**
Never run a browser inside `apps/api`. The split exists so a hung page cannot
take the public API down. Do not "temporarily" collapse them.

**3. Selectors are data, never code.**
A `SelectorDefinition` is a tagged union that an adapter maps to typed
Playwright calls. Never build a selector by string concatenation into
`page.locator()`, never accept user JavaScript, and validate untrusted selectors
with `validateSelectorDefinition` before they reach an adapter.

**4. AI is a port, and it only ranks.**
`SemanticResolverPort` receives a *shortlist* that deterministic filtering has
already produced, and returns rankings. It never executes, navigates or writes
to the Registry. Low-level adapters must never call a model.

**5. Failures are values at pipeline level.**
Return `Result<T>` from anything that can fail for a non-programmer reason —
a selector matching nothing, a precondition that cannot be met. Throwing loses
the timeline entry that makes the failure reviewable. Throw only for genuine
programmer errors and at composition-root boundaries.

## Adding a new port and adapter

1. Define the interface in `packages/application/src/ports/<name>-port.ts`.
   Use only domain and wire types in its signature — no library types.
2. Export it from `packages/application/src/ports/index.ts`.
3. Implement it under an `infrastructure/` folder in the app that needs it.
4. Bind it in the composition root (`apps/api/src/infrastructure/container.ts`
   or `apps/worker/src/main.ts`). Nothing else constructs adapters.

If the interface needs a library type to express itself, the abstraction is
wrong — find the Runner-level concept it is hiding.

## Adding a new live capability

1. Add the command type to `LIVE_COMMAND_TYPES` and its payload to
   `LiveCommandPayloadMap` in `packages/live-protocol`.
2. Add it to `contracts/json-schema/live-command-v1.schema.json`, with an
   `if/then` block if the payload has required fields.
3. Implement `LiveCapability` in `apps/worker/src/capabilities/<namespace>/`.
4. Register it in `apps/worker/src/main.ts`.

Leave a command unregistered until it works. An unregistered command returns a
precise `LIVE_COMMAND_UNSUPPORTED`, which is more useful than a silent no-op.

## What stays out of this repository

The Test Authoring / IR Generation service, natural-language handling, Jira and
Xray integration, and the main SaaS frontend. The Runner may store a submitted
IR snapshot for audit and replay, but it is not the system of record for
authored test cases.

## References

- `references/layering.md` — the dependency rule, with worked examples
- `references/phases.md` — what each build phase adds and what it must not
