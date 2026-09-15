---
name: git-commit
description: Write Conventional Commits messages for this repository — the allowed types, the scopes derived from the actual workspace layout, and how to split a working tree into separate commits. Load before running git commit, when asked to commit or to word a commit message, or when a commit is rejected by commitlint.
---

# Commit messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org).
The format is load-bearing, not cosmetic: the type and the `!` marker are what a
reader scans to answer "did the public contract move?", and in this repo the
public contract belongs to an external service that cannot be redeployed.

## The format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Only the first line is required. Rules:

- **type** — lowercase, from the table below. Required.
- **scope** — lowercase, from the table below. Optional, but include it whenever
  the change sits in one place.
- **!** — after the scope (`feat(contracts)!:`) when the change breaks a caller.
- **subject** — imperative mood ("add", not "added"/"adds"), no capital first
  letter, no trailing period, ≤ 72 characters for the whole first line.
- **body** — wrapped at 72 columns, separated by a blank line. Explain *why*,
  not what; the diff already says what.
- **footer** — `BREAKING CHANGE: …` and issue refs (`Refs: #123`).

## Types

| Type | Use for |
|---|---|
| `feat` | A new capability a caller can observe |
| `fix` | A bug fix |
| `refactor` | Behaviour unchanged, structure changed |
| `perf` | A change made for speed or memory |
| `test` | Tests only |
| `docs` | Documentation, CLAUDE.md, skills, OpenAPI *descriptions* |
| `build` | Build, bundling, Dockerfile, dependencies, pnpm workspace |
| `ci` | CI pipelines and workflows |
| `chore` | Housekeeping that fits nothing above |
| `revert` | Reverting a previous commit |

`docs` covers OpenAPI prose. A change to a *field*, an enum value or an error
code is `feat` or `fix` — it changes what a caller may send or must handle.

## Scopes

Derived from the workspace layout. Use the package or app name without the
`@runner/` prefix.

| Scope | Covers |
|---|---|
| `api` | `apps/api` — HTTP routes, WebSocket gateway, validation, queueing |
| `worker` | `apps/worker` — execution, Playwright adapter, capabilities |
| `live-web` | `apps/live-web` — the live authoring workspace |
| `domain` | `packages/domain` |
| `application` | `packages/application` — use cases, ports, mappers |
| `contracts` | `contracts/` and `packages/contracts-internal` — **public surface** |
| `registry` | `packages/registry-model` and the Registry modules |
| `locator` | The locator engine, resolver, inspector, scoring |
| `selector` | `packages/selector-model` |
| `test-ir` | `packages/test-ir-model` |
| `live-protocol` | `packages/live-protocol` — commands, events, capabilities |
| `shared` | `packages/shared` |
| `postgres` / `redis` | The infrastructure packages |
| `infra` | `infra/`, docker-compose, migrations, nginx |
| `deps` | Dependency bumps |

A change spanning several scopes takes no scope: `refactor: …`. If it spans
several scopes *and* is hard to describe in one subject, it should probably be
several commits.

## Breaking changes

A change is breaking when a caller integrating through `contracts/` must change
to keep working: a removed or renamed field, a narrowed type, a new required
field, a new error code a client must handle, a removed live command namespace.

Mark it twice — `!` in the header and a `BREAKING CHANGE:` footer saying what a
caller must do:

```
feat(contracts)!: require targetRef on every interaction step

Steps referenced elements positionally, which silently bound a test to
DOM order. Targets are now named and resolved through the Registry.

BREAKING CHANGE: ExecutionRequestV1 steps must carry targetRef. Requests
with positional targets are rejected with SCHEMA_VALIDATION_FAILED.
```

Adding an optional field or a new endpoint is **not** breaking.

## Splitting the work

One commit is one reviewable decision. Commit separately when the parts would be
reverted separately — a refactor and the fix it enables, a contract change and
the worker change that consumes it. Never mix a formatting sweep with a
behaviour change; the behaviour becomes invisible in the diff.

Use `git add -p` or path-scoped `git add` to stage a subset. Do not use `-A`
without looking at what it would sweep in.

## Before committing

```bash
git status
git diff --staged
```

Read the staged diff and write the message from it, not from your memory of the
task. If the diff contains something you did not intend to commit — a scratch
file, a `.env`, generated output — unstage it rather than describing it.

The user asks for commits; do not commit unrun. If on `master`, branch first.

## Attribution

End every commit message with the attribution line the session's system
reminder specifies, after a blank line.

## Examples

```
feat(live-protocol): add element.highlight command

fix(locator): apply the intent similarity floor before validation

An intent naming an absent element resolved to whichever candidate
sorted first, so a mistyped target clicked an unrelated control and
elementVisible reported itself satisfied. MIN_INTENT_SIMILARITY (0.4)
now gates resolution, matching the Registry's name-match threshold.

test(worker): guard page.evaluate helper injection

refactor(application): move plan mapping out of the execution use case

build(deps): bump playwright to 1.49.1

docs: describe the three persistence tiers in CLAUDE.md
```

Bad subjects, and why:

| Bad | Why |
|---|---|
| `fix: bug` | Names nothing; unsearchable in a log |
| `feat(api): Added endpoint.` | Past tense, capitalized, trailing period |
| `update files` | No type, no information |
| `wip` | Not a reviewable decision — squash it before pushing |
