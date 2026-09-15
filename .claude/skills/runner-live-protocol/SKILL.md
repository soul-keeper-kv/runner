---
name: runner-live-protocol
description: The live session command and event protocol — WebSocket transport, capability dispatch, selector preview, element picking and the live workspace UI. Load before adding a live command or event, editing packages/live-protocol, the worker capabilities, the API WebSocket gateway, or apps/live-web.
---

# The live session protocol

A live session holds a **real browser open** so a user can inspect, edit and
validate against the state that actually caused a problem. Everything below
exists to protect that property.

## The rule that shapes everything

```
Frontend → LiveSessionCommand → Capability → BrowserPort → Playwright adapter
```

The frontend never touches Playwright, and never learns that it exists. It emits
a typed command; a capability interprets it; only an adapter behind a port
drives a browser. Collapsing any arrow here is what the blueprint forbids in
section 3.1, and it is what keeps a second automation engine possible.

## Why a session must not restart

Editing a selector must never restart the browser. Preserve cookies,
`localStorage`, the current URL, scroll position, the open modal, the selected
tab and form values. A restarted browser loses exactly the state that made the
selector worth checking — the user is then debugging a different page.

## Adding a command

1. **Protocol** — add to `LIVE_COMMAND_TYPES` and give it a payload type in
   `LiveCommandPayloadMap` (`packages/live-protocol/src/live-commands.ts`).
   The namespace before the dot determines its capability.
2. **Schema** — add to the enum in
   `contracts/json-schema/live-command-v1.schema.json`, plus an `if/then` block
   if the payload has required fields. The gateway validates against this file,
   so an unlisted command is rejected at the socket.
3. **Capability** — implement or extend a `LiveCapability` in
   `apps/worker/src/capabilities/<namespace>/`.
4. **Register** — add it in `apps/worker/src/main.ts`.

Leave it unregistered until it works: an unregistered command returns a precise
`LIVE_COMMAND_UNSUPPORTED` naming the command, which is more useful to a client
developer than a silent no-op.

## Capabilities

One capability per namespace (blueprint section 28 is explicit that this must
not become a single `LivePreviewService`):

| Capability | Commands | State |
|---|---|---|
| `browser` | navigate, back, forward, refresh | Implemented |
| `selector` | preview, validate, confirm, reject | Preview implemented |
| `element` | highlight, pick.start, pick.cancel, describe | Phase 9 |
| `registry` | create-draft, rename, confirm, reject | Phase 10 |
| `execution` | step.execute, step.retry, session.pause/resume | Phase 7 |
| `state` | snapshot, inspect | Phase 7 |

`CapabilityRegistry.register()` throws if two capabilities claim one command —
that is a wiring bug, and failing at startup beats picking one arbitrarily.

## Message shapes

Client → server:

```json
{ "kind": "command",
  "command": { "id": "cmd_1", "sessionId": "ls_abc", "type": "selector.preview",
               "payload": { "selector": { "type": "role", "role": "button", "name": "Login" } } } }
```

Server → client, one of three kinds:

```json
{ "kind": "event", "event": { "id": "evt_1", "sessionId": "ls_abc", "type": "page.navigated",
                              "sequence": 4, "timestamp": "…", "payload": {} } }
{ "kind": "command-result", "result": { "commandId": "cmd_1", "ok": true, "result": {},
                                        "completedAt": "…", "revision": 7 } }
{ "kind": "error", "code": "VALIDATION_FAILED", "message": "…" }
```

`sequence` is monotonic per session and `revision` increments on every applied
command, so a client can detect that it missed something rather than silently
rendering stale state.

## Selector preview

The most-used command. It answers what an editor needs to know:

```
matchCount  0 → wrong or not present yet
            1 → usable
           >1 → ambiguous, the dangerous case
visible / enabled
bbox        for the overlay
score / stability
```

Zero matches is returned as a **result, not an error** — it is a normal state
while someone is typing. Surface ambiguity loudly: acting on the first of
several matches is how a run clicks the wrong row.

## Events

Normalized from the browser, never raw Playwright events:

```
page.navigated · dom.changed · frame.attached · popup.opened · dialog.opened
network.request/response · console.message/error
element.selected · element.picked
execution.started/step.started/step.completed/completed/failed/waiting_user
selector.failed · selector.preview.result
registry.proposed · registry.updated
session.state.changed · session.closed · command.failed · browser.frame
```

Publish through `EventBusPort`, never directly to a socket. Timeline, recorder,
registry learner and the WebSocket bridge all subscribe there, so adding a
consumer never requires touching a producer.

## Security

The gateway validates every frame against the published schema, and rejects a
command whose `sessionId` does not match the socket. Selectors are validated
again in the capability before reaching an adapter.

Never accept user JavaScript or a code string as a selector. The
`SelectorDefinition` union plus `validateSelectorDefinition` is what keeps the
editor from being an arbitrary-code-execution path (blueprint rules 11 and 50).

## Live view rendering

`LiveViewProvider` is deliberately an interface. MVP is screenshot plus bbox
overlay; CDP screencast and WebRTC come later. Do not hardcode the screenshot
approach into UI components — highlight positions come from
`BrowserPort.highlight()` and `probe()`, not from converting semantic locators
back into CSS.

## The workspace

`apps/live-web` drives the Runner through the **same public API an external
service uses**. It has no privileged back door, on purpose: if something is
awkward here, it is awkward for every integrator, and that is worth discovering
early.

- `lib/runner-api.ts` — HTTP client
- `lib/live-socket.ts` — WebSocket with capped exponential reconnect
- `stores/live-session-store.ts` — session state and command sending
- `features/*` — one folder per panel
