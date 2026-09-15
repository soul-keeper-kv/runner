# Integrating with the Runner

Written for: engineers building a service that submits tests to the Runner.

You need no Runner source code, no shared database, and no particular language.
You need this document, `/openapi.json`, and the ability to POST JSON.

## 1. Discover what the deployment supports

```bash
curl -s https://runner.example.com/api/v1/capabilities
```

Check `contracts.execution` and `contracts.testIr` for the versions to declare,
and `features[]` for whether optional behaviour (self-healing, AI resolution) is
`AVAILABLE` or still `PLANNED` in this deployment. Do this at startup rather
than hardcoding assumptions — it turns a runtime failure into a startup log.

## 2. Build Test IR

Name targets semantically. Do not send selectors — the Runner rejects them.

```json
{
  "id": "tc-4711",
  "name": "Manager approves a submitted order",
  "steps": [
    { "id": "s1", "type": "goto", "value": "/orders/123" },
    {
      "id": "s2",
      "type": "click",
      "target": { "name": "Review Tab", "description": "Opens the order review section" }
    },
    {
      "id": "s3",
      "type": "click",
      "target": { "elementId": "el_approve_order", "name": "Approve Order Button" },
      "preconditions": [
        { "type": "authenticated", "profile": "MANAGER" },
        { "type": "entityState", "entity": "ORDER", "state": "SUBMITTED" }
      ]
    },
    {
      "id": "s4",
      "type": "assert",
      "target": { "name": "Order Status Badge" },
      "assertion": { "type": "containsText", "expected": "Approved" }
    }
  ]
}
```

**Prefer `elementId` when you have one.** It is stable across renames and
selector changes. Get one from `GET /api/v1/registry/elements?workspaceRef=…`
or from a previous execution result. `name` and `description` work when you do
not — the Runner resolves those semantically — but they are weaker.

## 3. Validate before you schedule

```bash
curl -X POST https://runner.example.com/api/v1/validate/test-ir \
  -H 'content-type: application/json' -d @ir.json
```

A `400` names the exact JSON path that is wrong:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "kind": "CONTRACT_FAILURE",
    "message": "Payload does not match test-ir-v1.schema.json: /steps/0 must have required property 'target'",
    "details": { "issues": [{ "path": "/steps/0", "message": "must have required property 'target'" }] }
  }
}
```

Validating here converts an execution-time failure into an authoring-time one,
which is usually the difference between a fixable bug and a flaky test suite.

## 4. Submit

```bash
curl -X POST https://runner.example.com/api/v1/executions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: tc-4711-run-88' \
  -d '{
    "contractVersion": "runner.execution.v1",
    "irVersion": "test-ir.v1",
    "workspaceRef": "workspace_checkout",
    "externalTestCaseRef": "XRAY-1741",
    "authProfileRef": "manager-user",
    "mode": "AUTO",
    "test": { "...": "your IR" }
  }'
```

Returns `202` immediately:

```json
{
  "executionId": "run_01j8x2c4",
  "status": "QUEUED",
  "statusUrl": "/api/v1/executions/run_01j8x2c4",
  "eventsUrl": "/api/v1/executions/run_01j8x2c4/events"
}
```

**Always send `Idempotency-Key`.** A network timeout on your side is
indistinguishable from a lost response; without the key, a retry starts a second
browser run. With it, the retry returns the original execution.

## 5. Get the result — pick one style

**Polling.** `GET` the `statusUrl` until `status` is `PASSED`, `FAILED` or
`CANCELLED`. Simple, works everywhere, fine for CI.

**Webhook.** Add `callback` to the request:

```json
"callback": {
  "url": "https://your-service.internal/hooks/runner",
  "events": ["execution.completed", "execution.failed"]
}
```

**Stream.** `GET` the `eventsUrl` as `text/event-stream`. The first event is a
full snapshot; the stream closes at a terminal status.

## 6. Read the result

```json
{
  "executionId": "run_01j8x2c4",
  "status": "FAILED",
  "steps": [
    {
      "stepId": "s3",
      "type": "click",
      "status": "FAILED",
      "resolvedElement": {
        "elementId": "el_approve_order",
        "displayName": "Approve Order Button",
        "confidence": 0.97,
        "selector": { "type": "role", "role": "button", "name": "Approve" }
      },
      "evidence": [
        "role matched button",
        "accessible name matched Approve",
        "selector uniquely matched 1 visible element"
      ],
      "error": { "code": "ASSERTION_FAILED", "kind": "TEST_FAILURE", "message": "…" }
    }
  ]
}
```

**Branch on `error.kind`, not on `status`.** A `FAILED` run with kind
`PRECONDITION_FAILURE` means your fixture or environment is wrong; one with
`TEST_FAILURE` means the application misbehaved; `RESOLUTION_FAILURE` means the
Runner could not find the element and your IR may need a stable `elementId`.
Reporting all three as "test failed" is how a suite loses its credibility.

`evidence` explains *why* the Runner chose that element. Surface it — it is what
makes a failed resolution diagnosable without opening a browser.

## 7. Learn stable ids back

When resolution succeeds, `resolvedElement.elementId` is a stable Registry id.
Storing it and using it in subsequent IR makes future runs faster and immune to
display-name changes.

## Execution modes

| Mode | Behaviour | Use for |
|---|---|---|
| `AUTO` | Runs unattended; proceeds on high confidence | CI |
| `REVIEW` | Pauses on an uncertain resolution and waits | Authoring, debugging |
| `INTERACTIVE` | User drives; the Runner observes and records | Recording |

`REVIEW` and `INTERACTIVE` need a human at a live session. For unattended
scheduling, use `AUTO`.

## What you must never do

- Import a Runner workspace package.
- Read or write the Runner database.
- Publish to the Runner's internal Redis queue.
- Send a selector or a password in Test IR.

Each of these turns a versioned boundary into a shared-deployment dependency,
which is precisely what the Runner is designed to avoid.
