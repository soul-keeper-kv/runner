# Runner Service

An extensible browser automation runtime and live authoring environment for
AI-assisted test automation.

The Runner is a **standalone, API-first service**. It receives structured
Test IR, resolves each step's target element against the live page, executes
it, and reports the result with evidence. It deliberately does **not** author
test cases or generate Test IR from natural language — that belongs to a
separate service which integrates over versioned HTTP contracts only.

## Why it is built this way

Most AI test tools generate Playwright code and hope it keeps working. This one
inverts that: the **Element Registry and execution state are the source of
truth**, and generated code is an output. A selector can change, an element can
be renamed, and previously generated tests keep running — because Test IR
references elements by stable identity and meaning, never by selector.

## Quick start

```bash
pnpm install
cp .env.example .env

pnpm infra:up                              # Postgres :5433, Redis :6380
pnpm --filter @runner/worker browsers:install

pnpm --filter @runner/api dev              # :3001
pnpm --filter @runner/worker dev           # separate terminal
pnpm --filter @runner/live-web dev         # :5173
```

The API also starts with **no** Postgres or Redis, using in-memory adapters, so
you can exercise the contract before Docker is running. It warns when it does,
and refuses to start that way under `NODE_ENV=production`.

## End-to-end example

Submit a test and poll until it finishes. This is the whole integration — no
SDK, no shared database, no source-code dependency.

**1. Check what this deployment supports**

```bash
curl -s http://localhost:3001/api/v1/capabilities | jq '.contracts'
```

```json
{
  "execution": ["runner.execution.v1"],
  "testIr": ["test-ir.v1"]
}
```

**2. Validate the Test IR before scheduling a browser run**

```bash
curl -s -X POST http://localhost:3001/api/v1/validate/test-ir \
  -H 'content-type: application/json' \
  -d '{
    "id": "tc-login-1",
    "name": "User logs in",
    "steps": [
      { "id": "s1", "type": "goto", "value": "https://example.com/login" },
      { "id": "s2", "type": "fill", "target": { "name": "Email Field" }, "value": "user@example.com" },
      { "id": "s3", "type": "click", "target": { "name": "Login Button", "description": "Submits the login form" } },
      { "id": "s4", "type": "assert", "target": { "name": "Welcome Heading" },
        "assertion": { "type": "containsText", "expected": "Welcome" } }
    ]
  }'
```

```json
{ "valid": true }
```

Note the absence of selectors. Targets are named; the Runner resolves them.

**3. Submit the execution**

```bash
curl -s -i -X POST http://localhost:3001/api/v1/executions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: tc-login-1-run-001' \
  -d '{
    "contractVersion": "runner.execution.v1",
    "irVersion": "test-ir.v1",
    "requestId": "req_demo_1",
    "workspaceRef": "workspace_demo",
    "externalTestCaseRef": "XRAY-1741",
    "mode": "AUTO",
    "test": {
      "id": "tc-login-1",
      "name": "User logs in",
      "steps": [
        { "id": "s1", "type": "goto", "value": "https://example.com/login" },
        { "id": "s2", "type": "fill", "target": { "name": "Email Field" }, "value": "user@example.com" },
        { "id": "s3", "type": "click", "target": { "name": "Login Button" } },
        { "id": "s4", "type": "assert", "target": { "name": "Welcome Heading" },
          "assertion": { "type": "containsText", "expected": "Welcome" } }
      ]
    }
  }'
```

```text
HTTP/1.1 202 Accepted
location: /api/v1/executions/run_619ccd03b2344404
```

```json
{
  "executionId": "run_619ccd03b2344404",
  "status": "QUEUED",
  "statusUrl": "/api/v1/executions/run_619ccd03b2344404",
  "eventsUrl": "/api/v1/executions/run_619ccd03b2344404/events",
  "requestId": "req_demo_1",
  "acceptedAt": "2026-09-14T14:37:23.530Z"
}
```

Always send `Idempotency-Key`: a network timeout on your side is
indistinguishable from a lost response, and without it a retry starts a second
browser run.

**4. Poll until it reaches a terminal status**

```bash
RUN=run_619ccd03b2344404

until [ "$(curl -s localhost:3001/api/v1/executions/$RUN | jq -r .status)" \
        != "QUEUED" ] && \
      [ "$(curl -s localhost:3001/api/v1/executions/$RUN | jq -r .status)" \
        != "RUNNING" ]; do
  sleep 1
done

curl -s localhost:3001/api/v1/executions/$RUN | jq
```

```json
{
  "contractVersion": "runner.execution.v1",
  "executionId": "run_619ccd03b2344404",
  "workspaceRef": "workspace_demo",
  "externalTestCaseRef": "XRAY-1741",
  "status": "PASSED",
  "mode": "AUTO",
  "durationMs": 3184,
  "steps": [
    {
      "stepId": "s3",
      "type": "click",
      "status": "PASSED",
      "durationMs": 412,
      "resolvedElement": {
        "displayName": "Login Button",
        "confidence": 0.97,
        "selector": { "type": "role", "role": "button", "name": "Login" }
      },
      "evidence": [
        "role matched button",
        "accessible name \"Login\" matched intent \"Login Button\"",
        "selector role=button[name=\"Login\"] scored 95",
        "selector uniquely matched 1 visible element"
      ]
    }
  ]
}
```

`evidence` is the point: every resolution explains itself, so a wrong or failed
match is diagnosable without opening a browser.

**Or, instead of polling** — stream progress, or receive a webhook:

```bash
curl -N http://localhost:3001/api/v1/executions/$RUN/events
```

```jsonc
// or add to the execution request:
"callback": {
  "url": "https://your-service.internal/hooks/runner",
  "events": ["execution.completed", "execution.failed"]
}
```

## Verify it end to end

With the API and worker running against the same Redis:

```bash
pnpm e2e
```

It serves a small fixture page, submits the four-step IR above, polls to a
terminal status, and prints the resolution evidence for each step:

```text
status: PASSED  (317ms)
  ok   s1 goto -> PASSED
  ok   s2 fill -> PASSED
       {"type":"role","role":"textbox","name":"Email"}  confidence 0.97
  ok   s3 click -> PASSED
       {"type":"testId","value":"login-submit"}  confidence 1
       . role matched button
       . accessible name "Login" matched intent "Login"
       . selector testId=login-submit scored 100
       . selector uniquely matched 1 visible element
  ok   s4 assert -> PASSED
       {"type":"text","value":"Welcome back"}  confidence 0.85
```

Note step 3: the IR said `{ "name": "Login", "role": "button" }` and the Runner
chose `data-testid=login-submit` over the Cancel button beside it, scoring 100
and matching exactly one element. No selector was supplied by the caller.

## How resolution works

```text
PageSnapshot (≈100 candidates from ≈10,000 DOM nodes)
   → filter by interactability and semantics
   → rank by label similarity
   → generate several selectors per candidate
   → score: data-testid 100 · role+name 95 · … · xpath 30
   → validate on the live page: 0 / 1 / many matches
   → ResolvedElement + confidence + evidence
```

Entirely deterministic. AI sits behind `SemanticResolverPort` and arrives in
Phase 13 to rerank a shortlist — it never executes, navigates, or writes to the
Registry.

## Repository layout

```text
apps/api        Public HTTP + WebSocket API. Validates, queues, reports.
apps/worker     Playwright execution. The only place browsers exist.
apps/live-web   Live authoring workspace (React + Vite).

packages/       Private. Never imported by another service.
  shared            Result, RunnerError, ids, clock, logger
  selector-model    Structured selector DSL, scoring weights, heuristics
  test-ir-model     Public Test IR and execution contracts
  registry-model    Element/Page/Component, revisions, confidence policy
  live-protocol     Typed live command and event protocol
  domain            Internal models (ElementCandidate, PageSnapshot, …)
  application       Ports, use cases, inbound/outbound mappers
  contracts-internal JSON Schema validation, capability descriptor

contracts/      PUBLIC. OpenAPI + JSON Schema — the integration surface.
infra/          docker-compose + SQL migrations
docs/           architecture notes and ADRs
.claude/skills/ Skills for AI agents working in this repository
```

## Public API

| Endpoint | Purpose |
|---|---|
| `GET /health`, `GET /ready` | Liveness and readiness |
| `GET /openapi.json` | The full API document |
| `GET /api/v1/capabilities` | Supported contracts and features |
| `GET /api/v1/schemas/:name` | Published JSON Schemas |
| `POST /api/v1/validate/test-ir` | Validate without running |
| `POST /api/v1/executions` | Submit → `202` |
| `GET /api/v1/executions/:id` | Status and result |
| `GET /api/v1/executions/:id/events` | SSE progress stream |
| `POST /api/v1/executions/:id/cancel` | Cooperative cancellation |
| `POST /api/v1/live-sessions` | Start a live browser session |
| `WS /api/v1/live-sessions/:id/ws` | Live command protocol — browser + selector |
| `POST /api/v1/inspections` | Inspect a page → `202` |
| `GET /api/v1/inspections/:id` | Fields, submit control, ranked selectors |
| `GET /api/v1/registry/elements` | Search by name, alias or description |
| `GET /api/v1/registry/resolve` | Would this target resolve? No browser |
| `GET /api/v1/registry/modifications` | Pending drafts awaiting review |
| `GET /api/v1/registry/revisions/:id` | An entity's change history |

## Integration boundary

A Test Authoring / IR Generation service — in any language — integrates through
HTTP, OpenAPI, JSON Schema, WebSocket and webhooks. It must never import a
`packages/*` package, read or write the Runner database, or publish to the
internal queue.

See `.claude/skills/runner-contracts/references/integration-guide.md`.

## Current state

Phases 0–5 and 7–9 are implemented: workspace and contracts, the public API and
queue, the Playwright adapter and browser runtime, page inspection, the
deterministic locator engine, the Element Registry — stable ids, names, aliases,
draft-then-commit modifications and revision history behind `RegistryPort` —
authentication, live session command dispatch, where a WebSocket command reaches
a capability in the worker and drives a browser the session holds open between
commands, the live view, and element picking.

The Registry's system of record is **Postgres**. Element identity is the one thing
here that must not be disposable — every previously generated Test IR references
it — so a Redis flush must not be able to orphan it. `confirmModification` applies
the change, writes its revision and decides the modification in a single
transaction, and `registry_revisions` carries `UNIQUE (entity_id, version)` so two
concurrent confirmations cannot both claim one version number. Redis remains the
fallback for a developer running without a database, and in-memory for one running
with neither; each step down is a step further from durable, and the API says so
in its startup log.

Apply the schema with `pnpm db:migrate`. It records what it has applied in
`schema_migrations`, and adopts an existing schema as its baseline — a fresh
`pnpm infra:up` container already applies the same files on first boot.

AI sits behind `SemanticResolverPort` and is consulted **last** — only after
deterministic ranking has refused every candidate. It reranks a shortlist on the
signals a label comparison throws away: the text around an element, the form and
component it sits in, the landmark above it. It never executes or navigates, it
is handed neither a browser nor the Registry, and whatever it picks is still
validated against the live page before it is used. Its reasoning is recorded as
evidence, and the resolution is marked `SEMANTIC_AI` so a reviewer can see that a
ranker chose the element and why. This build binds a heuristic reranker; an
LLM-backed adapter implements the same port and swaps in at the composition root.

Self-healing **proposes, never repairs**. When a registry-backed selector stops
matching, the element is re-located by its *meaning* — the name a person gave it
and the aliases it answers to, never by position — and a `SELECTOR_UPDATE`
modification is recorded with `proposedBy: HEALING`, the replaced selector kept
in history. The failing step still fails, with the proposal attached as evidence:
a test that passed because the Runner quietly repaired its own mapping would hide
the UI change that caused it. AUTO mode may commit a proposal above
`autoHealThreshold` (0.97); REVIEW mode asks. Healing also refuses to act when
the stored selector still matches, when the element is genuinely absent, and when
the replacement would resolve ambiguously.

Recording produces **Test IR, not Playwright code** — so a recorded step
references its element by name and survives the UI change that would break a
captured selector. Observation is client-driven: nothing is injected into the
page under test. The worker normalizes the stream, which is where the value is —
a person typing produces one `fill` rather than eight keystrokes, a click that
only focuses a field is not a step, and re-navigating to the current page is
dropped. What comes out can be submitted straight back to
`POST /api/v1/executions`.

Registry editing closes the authoring loop: pick an element, name it, and what is
written is a **draft** — a `RegistryModification` carrying an explicit
before/after that the API shows at `/api/v1/registry/modifications`. Confirming
is a separate, recorded step that applies the change and writes a revision;
rejecting leaves the element and its history untouched. Nothing writes the
Registry directly (ADR 0003), which is what makes undo, diff and auditable
self-healing possible later. Picking an element that is already stored reports
its `elementId`, matched by selector identity rather than by name — a user names
an element for what it means while the DOM says what it shows.

All five precondition types are dispatched: `authenticated` logs in,
`urlMatches` and `elementVisible` verify the starting point, and `uiState` and
`entityState` report precisely what is missing. Three of those deliberately
refuse to *prepare* — the Runner will not navigate, click or seed a database to
make a precondition true, because doing so would silently change what the test
covers. An unreachable precondition fails as `PRECONDITION_FAILED`; only a
genuine assertion failure is a `TEST_FAILURE`.

Authentication follows blueprint section 50: Test IR names an `authProfileRef`,
a profile references its credentials by environment-variable **name**, and the
password is resolved for one login and never written to a log, an error payload
or the stored session. A `FORM_LOGIN` profile is replayed once; the browser state
it produced is cached, so later runs start already signed in. A login that cannot
be performed fails with `PRECONDITION_FAILED`, never as a test failure — the
application under test has not been shown to misbehave.

The live `browser`, `selector`, `state`, `element` and `registry` namespaces
answer today — 19 commands in all.
`state.snapshot` returns the page as a frame plus the bounding boxes the
workspace draws its highlights from, and `element.describe` takes a point on that
frame and answers with the element there — named, role-resolved, and with its
selectors already ranked and probed against the live page. A command in a
namespace that has not shipped returns `LIVE_COMMAND_UNSUPPORTED` naming the
command, rather than a silent no-op.

Phases 5, 6 and 10+ — authentication, preconditions, registry drafts for pages
and components, the recorder, self-healing and AI resolution — exist as ports and
stubs that return `CAPABILITY_NOT_IMPLEMENTED` naming their phase, so an
integrator always learns precisely what is missing.

`GET /api/v1/capabilities` is the authority on what a given build supports, and
it reports those as `PLANNED` rather than `AVAILABLE`. Check it before
integrating: it describes the deployment you are talking to, not this roadmap.

## Development

```bash
pnpm typecheck    # strict TypeScript across the workspace
pnpm lint         # also enforces the architecture boundaries
pnpm test         # unit tests, no browser required
pnpm build        # build everything
```

`pnpm lint` enforces layering rules — no Playwright outside the adapter, no
persistence clients in the domain, no internal models in the frontend. A failure
there is usually a design problem rather than a formatting one.
