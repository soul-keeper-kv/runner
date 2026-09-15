# Layering

```
infrastructure  →  application  →  domain
(Playwright,       (use cases,      (pure types,
 Postgres,          ports,           no imports)
 Nest, Redis)       mappers)
```

Dependencies point inward. Inversion is how an inner layer "uses" an outer one:
the application declares `BrowserPort`, infrastructure implements it.

## Enforced by lint

`eslint.config.js` fails the build on:

- Playwright, Drizzle, `pg`, `ioredis`, `bullmq` or `@nestjs/*` inside
  `packages/domain` or `packages/application`
- Playwright inside `apps/worker/src/capabilities/**`
- `@runner/domain` inside `apps/live-web`
- `@runner/domain` or `@runner/application` inside a wire-model package

## Not enforced by lint

- A public `*V1` DTO must not appear inside `apps/worker/src/modules/`
- The API must not run a browser
- Registry writes must go through a modification
- `Result` for expected failures; `throw` only for programmer errors

See `.claude/skills/runner-architecture/` for the full guidance and worked
examples.
