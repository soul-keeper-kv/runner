# Service boundary

```
Test Authoring / IR Generator Service   (separate deployable, any language)
              |
              |  HTTP JSON · OpenAPI · JSON Schema · WebSocket · webhook
              v
        RUNNER PUBLIC API
              |
        Runner application core
              |
        Playwright workers
```

## Allowed

OpenAPI endpoints, JSON Schema contracts, HTTP JSON, public WebSocket and SSE
events, webhook callbacks, and an optional SDK generated from OpenAPI.

## Forbidden

- Importing a Runner workspace package
- Reading or writing the Runner database
- Publishing to the Runner's internal BullMQ queue
- Knowing Playwright implementation classes
- The Runner importing test-case generation logic, or querying another
  service's database

## Ownership

The Runner owns execution jobs, IR snapshots, browser and live sessions, auth
profiles and secret references, the Registry, selector history, revisions, the
timeline, evidence, and healing knowledge.

It does not own test-case authoring, natural-language generation, test-case
lifecycle, or Jira/Xray domain data. It stores an immutable copy of a submitted
IR for audit and replay — that is not a system of record for authored tests.
