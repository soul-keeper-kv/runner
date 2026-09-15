# Build phases

The order is not arbitrary. Each phase exists because the one before it makes
the next tractable, and skipping ahead produces a system that cannot be
debugged. In particular, AI comes last — after deterministic resolution works,
so there is something to compare a model's answer against.

## Status in this repository

| Phase | What it adds | State |
|---|---|---|
| 0 | Workspace, contracts, API, queue, docker-compose | **Done** |
| 1 | Browser runtime: manager, adapter, goto/click/fill/assert | **Done** |
| 2 | Inspector: `PageSnapshot`, candidate filtering | **Done** |
| 3 | Locator engine: generate, score, validate, resolve | **Done** |
| 3.5 | Page inspection API: URL in, draft registry entries out | **Done** |
| 4 | Registry: stable ids, names, aliases, fallbacks, history | **Done** |
| 5 | Authentication: `storageState`, form login, tokens, profiles | **Done** (FORM_LOGIN + API_TOKEN + STORAGE_STATE, arbitrary request headers; executions, inspections and live sessions; profiles managed over the API or declared in the environment) |
| 6 | Preconditions: handlers, explicit pre-steps | **Done** (entityState needs a seeding port) |
| 7 | LiveSession: capability dispatch wired end to end | **Done** (browser, selector, state, element, registry, recording, auth) |
| 8 | Live preview: screenshot view, bbox highlight, confirm/reject | **Done** (view + highlight) |
| 9 | Pick element: click a point, ranked selectors back | **Done** |
| 10 | Registry drafts and revisions | **Done** (live editing, Redis-backed, shared by API + worker) |
| 11 | Recorder: interactions → Test IR | **Done** (client-driven, normalized) |
| 12 | Self-healing: propose replacement selectors | **Done** (proposes only; AUTO may commit) |
| 13 | AI semantic resolver | **Done** (heuristic reranker behind the port; LLM adapter swaps in) |

"Stub" means the class exists and returns `CAPABILITY_NOT_IMPLEMENTED` with a
message naming its phase. That is deliberate: a caller learns precisely what is
missing instead of receiving an empty result that looks like an answer.

A stub must also be declared as unavailable in `capabilities.ts`. Those flags
default to `false` for that reason: an omitted flag under-promises, and a build
that answers `501` while advertising `AVAILABLE` is worse than one that never
advertised the feature at all.

## What each phase must not do

**Phase 3.5 (Inspection)** must not write to the Registry. It returns *draft*
entries — `systemName`, `displayName`, aliases, ranked selectors and a
first-sighting confidence — and persisting any of them is Phase 4's job, through
a modification. An inspection that quietly created registry rows would bypass
the draft-then-commit rule before Phase 4 has a chance to enforce it.

Its confidence is capped below `autoExecuteThreshold` for the same reason: one
look at a page carries no success history and no human confirmation.

**Phase 4 (Registry)** must not let a write bypass `RegistryModification`.
Draft-then-commit is what makes undo, diff and auditable healing possible; a
direct update path added "just for imports" removes that permanently.

**Phase 5 (Auth)** must not put a password in Test IR, the Registry, or a log.
IR references a profile; the profile references a secret; only the worker
running that execution resolves it.

The same rule binds the live `auth.login` command, and more tightly: it arrives
over a WebSocket from a browser tab, so its payload names a profile and
`additionalProperties` is `false` — a client cannot even send a field called
`password`. A token is the same kind of secret as a password — holding one *is* being
authenticated — so it never reaches a log, a result or an error payload, and a
stored token is sealed like any other credential. What a profile may state
freely is *where* a token goes and which headers accompany it: those name a
storage key, a cookie or a header, never a value.

A live session must also never conclude it is authenticated by
reading the page; `authenticatedAs` is set from a restored session or a
completed login, nothing else.

**Phase 6 (Preconditions)** must not report a setup failure as a test failure.
`PRECONDITION_FAILED` and `ASSERTION_FAILED` have different `kind` values for
this reason — a team that cannot tell a broken fixture from a broken feature
stops trusting its results.

**Phase 7 (LiveSession)** must not restart the browser on a selector edit. The
whole value of a live session is that the page keeps the state that produced
the problem.

**Phase 12 (Healing)** must not silently mutate a confirmed selector. It
proposes; AUTO mode may commit under policy; REVIEW mode asks.

**Phase 13 (AI)** must not become the executor. It ranks a shortlist behind
`SemanticResolverPort`. If deterministic resolution is failing often enough that
AI looks like the fix, the bug is usually in scoring or filtering — fix that
first, because a model cannot explain itself to a reviewer the way evidence can.

## Adding a phase

1. Implement behind the port or interface that already exists for it.
2. Flip its `CapabilityStatus` in `packages/contracts-internal/src/capabilities.ts`
   from `PLANNED` to `AVAILABLE` — `/api/v1/capabilities` must describe this
   build, not the roadmap.
3. Add tests for the decision logic before wiring it to a browser.
4. Update the table above.
