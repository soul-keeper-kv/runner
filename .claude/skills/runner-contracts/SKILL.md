---
name: runner-contracts
description: How to change the Runner's public API safely — OpenAPI, JSON Schema, Test IR, execution requests, versioning and error codes. Load before editing anything in contracts/, adding or changing an HTTP route, adding a field to a request or response, or changing an error code. Also use when an external service needs to integrate with the Runner.
---

# Changing the public contract

`contracts/` is the Runner's only supported integration surface. A future Test
Authoring / IR Generation service — possibly in Java, Python or Go — integrates
by reading these documents. It never imports a `packages/*` workspace package,
never writes the Runner database, and never publishes to the internal queue.

That constraint is what makes these files different from ordinary source: a
careless edit here breaks a service you cannot see or redeploy.

## The three places a contract lives

A public field exists in three files, and all three must agree:

1. `contracts/json-schema/*.schema.json` — the runtime validator. The API
   validates real requests against **this file**, not a TypeScript copy.
2. `contracts/openapi/runner-v1.yaml` — the human- and tool-facing document
   served at `/openapi.json`.
3. `packages/test-ir-model` (or `live-protocol`) — the TypeScript type used
   inside this repository.

Change one and you have a bug that only appears for external callers. The
schema tests in `packages/contracts-internal/test/` exist to catch drift.

## Compatible vs breaking

**Compatible inside `v1`** — safe to ship:
- adding an optional field
- adding a value to an enum the Runner *returns* (callers already handle
  unknown statuses defensively, and `capabilities` announces it)
- adding a new endpoint
- relaxing a constraint (a wider `maxLength`)

**Breaking** — requires `v2`:
- adding a required field
- removing or renaming any field
- narrowing a type or constraint
- changing what a field means while keeping its name
- adding a value to an enum the Runner *accepts* if old Runners reject it

When in doubt, ask: could a caller written against today's document still
succeed unchanged? If not, it is breaking.

## Adding a field: the sequence

Say a caller needs `retryPolicy` on a step.

1. **JSON Schema** — add it to `test-ir-v1.schema.json` under
   `$defs.testAction.properties`. Note `additionalProperties: false` is set
   deliberately: it turns a caller's typo into an immediate, precise error
   rather than a silently ignored field.
2. **OpenAPI** — add it to `TestActionV1` in `runner-v1.yaml` with a
   description saying what it does, not what type it is.
3. **TypeScript** — add it as optional to `TestActionV1` in
   `packages/test-ir-model/src/test-action.ts`.
4. **Mapper** — decide the internal representation in
   `packages/application/src/mappers/inbound-test-action-mapper.ts`. It need
   not have the same shape; the mapper is where defaults are applied and
   input is normalized.
5. **Test** — add a case to `packages/contracts-internal/test/` for a valid
   payload and for the rejection you expect.

## Versioning

Every submitted execution declares both versions:

```json
{ "contractVersion": "runner.execution.v1", "irVersion": "test-ir.v1" }
```

An unsupported version is rejected with `CONTRACT_VERSION_UNSUPPORTED` and the
list of supported versions in `details`, so a caller can correct itself without
reading documentation. Supported versions are declared in
`SUPPORTED_CONTRACT_VERSIONS` in the mapper and published at
`/api/v1/capabilities`.

## Error codes are part of the contract

Codes in `packages/shared/src/errors/error-codes.ts` cross the API boundary.
Add freely; never rename or repurpose one.

Each code carries a `kind`, and the distinction matters more than it looks:

| kind | Meaning |
|---|---|
| `TEST_FAILURE` | The application under test behaved wrongly |
| `PRECONDITION_FAILURE` | Setup could not be reached — not the app's fault |
| `RESOLUTION_FAILURE` | The Runner could not identify the target element |
| `INFRASTRUCTURE_FAILURE` | The Runner or its dependencies failed |
| `CONTRACT_FAILURE` | The request was invalid |

A team that cannot tell a broken fixture from a broken feature stops trusting
its test results. When adding a code, choose its `kind` by asking *who would
have to fix this*.

## HTTP status mapping

Set in `apps/api/src/presentation/middleware/runner-exception.filter.ts`.
Notable choices: `501` for a capability that is planned but not implemented
(so an integrator can tell "not yet" from "not allowed"), and `409` for
cancelling an already-finished execution.

## The three integration styles

All three are equally supported and none requires source-code coupling:

1. **Polling** — `POST /api/v1/executions`, then `GET` the status URL.
2. **Webhook** — supply `callback.url` and `callback.events`.
3. **Stream** — consume SSE at `/api/v1/executions/:id/events`.

When adding an execution state or event type, update all three paths, plus
`PUBLIC_EXECUTION_EVENTS` in `packages/test-ir-model`.

## Things that must never enter the contract

- **A raw selector in Test IR.** Targets are named by `elementId`, `name`, or
  `description`; selectors live in the Registry. This is what lets a selector
  heal without invalidating previously generated IR. The schema enforces it via
  `additionalProperties: false` on `elementIntent`.
- **A credential.** IR carries `authProfileRef`; the profile references a
  secret; the secret is resolved per execution.
- **The caller's domain model.** `tenantRef`, `workspaceRef` and
  `externalTestCaseRef` are opaque strings the Runner never interprets.

## Verifying a change

```bash
pnpm --filter @runner/contracts-internal test   # schema behaviour
pnpm --filter @runner/application test          # mapper behaviour
curl -s localhost:3001/openapi.json | head -40  # served document
curl -s localhost:3001/api/v1/capabilities      # what this build supports
```

## References

- `references/integration-guide.md` — hand this to an integrating service
