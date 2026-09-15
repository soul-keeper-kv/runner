# Runner Service images: api, worker, live-web.
#
# One Dockerfile with three runtime targets, because all three are built from the
# same pnpm workspace and share the same dependency graph. Building them
# separately would install the workspace three times.
#
#   docker build --target api       -t runner-api .
#   docker build --target worker    -t runner-worker .
#   docker build --target live-web  -t runner-live-web .
#
# The worker's base image is pinned to the *exact* Playwright version resolved in
# pnpm-lock.yaml. A mismatch between the client library and the browsers baked
# into the base image is the usual cause of "browser not found" or a silent
# protocol error inside a container, and it is invisible until runtime.

# ---------------------------------------------------------------------------
# Base: the workspace, installed once
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# A build has no terminal, and pnpm refuses to purge a modules directory without
# one (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) — which is what the later
# `--prod` install needs to do. This is pnpm's own documented answer, and it also
# silences the update notifier.
ENV CI=true
# Matches `packageManager` in package.json, so the lockfile is honoured exactly.
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

WORKDIR /app

# Manifests first: this layer is cached until a dependency actually changes,
# which is what keeps an ordinary source edit from re-installing everything.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json          apps/api/
COPY apps/worker/package.json       apps/worker/
COPY apps/live-web/package.json     apps/live-web/
COPY packages/application/package.json            packages/application/
COPY packages/contracts-internal/package.json     packages/contracts-internal/
COPY packages/domain/package.json                 packages/domain/
COPY packages/infrastructure-postgres/package.json packages/infrastructure-postgres/
COPY packages/infrastructure-redis/package.json   packages/infrastructure-redis/
COPY packages/live-protocol/package.json          packages/live-protocol/
COPY packages/registry-model/package.json         packages/registry-model/
COPY packages/selector-model/package.json         packages/selector-model/
COPY packages/shared/package.json                 packages/shared/
COPY packages/test-ir-model/package.json          packages/test-ir-model/

# `--frozen-lockfile` fails rather than silently resolving something new: an
# image must never contain dependencies the lockfile does not describe.
#
# `--ignore-scripts` is needed because pnpm 11 fails the install with
# ERR_PNPM_IGNORED_BUILDS even though `onlyBuiltDependencies` in
# pnpm-workspace.yaml already lists every package it names. Measured, not
# assumed: pnpm reads the allowlist (`pnpm config get` returns it inside the
# image) but does not apply it to that gate, and passing the same list as
# `--config.onlyBuiltDependencies[]=…` fails identically.
#
# Skipping those three scripts is safe here, which is why this is a fix and not
# a suppression:
#   esbuild            - its linux binary ships as the @esbuild/linux-x64
#                        package, present and executable without install.js.
#                        `vite build` in the next stage is the real proof.
#   @nestjs/core       - postinstall is `opencollective || exit 0`, a funding
#                        notice that already no-ops.
#   msgpackr-extract   - an optional native accelerator for msgpackr; BullMQ
#                        falls back to pure JS.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# Build: compile every workspace package once
# ---------------------------------------------------------------------------
FROM base AS build

COPY tsconfig.base.json ./
COPY contracts/ contracts/
COPY infra/migrations/ infra/migrations/
COPY packages/ packages/
COPY apps/ apps/

# Belt and braces with .dockerignore: `composite`/`incremental` make tsc trust a
# stale tsconfig.tsbuildinfo and skip emit, which fails as a confusing TS2307 in
# a *dependent* package rather than in the one that produced no output. Deleting
# any build state that reached the context makes the image build from scratch
# whatever the host happened to leave behind.
RUN find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete \
 && rm -rf packages/*/dist apps/*/dist

RUN pnpm run build

# A production install of the same lockfile, so the runtime layers carry no
# devDependencies (typescript, vitest, eslint) at all.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------------------
# api
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS api

ENV NODE_ENV=production
WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM, which is what lets the API run
# its shutdown hooks (drain requests, close the queue) instead of being killed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules           ./node_modules
COPY --from=build /app/package.json           ./package.json
COPY --from=build /app/contracts              ./contracts
COPY --from=build /app/infra/migrations       ./infra/migrations
COPY --from=build /app/packages               ./packages
COPY --from=build /app/apps/api/node_modules  ./apps/api/node_modules
COPY --from=build /app/apps/api/dist          ./apps/api/dist
COPY --from=build /app/apps/api/package.json  ./apps/api/package.json

# The schema registry reads contracts/json-schema at runtime by walking up from
# its own module, so the published contracts must be present in the image.

USER node
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]

# ---------------------------------------------------------------------------
# worker — the only image that contains a browser
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.63.0-jammy AS worker

ENV NODE_ENV=production
WORKDIR /app

# The Playwright base image does not ship dumb-init, and the worker needs a
# reaper more than the API does: every browser is a tree of Chromium processes,
# and an unreaped crash leaves zombies that outlive the job.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules              ./node_modules
COPY --from=build /app/package.json              ./package.json
COPY --from=build /app/packages                  ./packages
COPY --from=build /app/apps/worker/node_modules  ./apps/worker/node_modules
COPY --from=build /app/apps/worker/dist          ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json  ./apps/worker/package.json

# The base image ships the browsers; this is where they live.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# `pwuser` comes with the Playwright image. Chromium must not run as root.
USER pwuser

# The worker exposes no port: it is reached through Redis, never addressed
# directly. Liveness is "is the process up", which the container already knows.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/worker/dist/main.js"]

# ---------------------------------------------------------------------------
# live-web — static assets behind nginx, which also proxies the API
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS live-web

# Vite's dev server proxies /api to the API so the browser sees one origin; that
# proxy does not exist in a built bundle. nginx takes its place, which keeps the
# WebSocket upgrade and the same-origin property identical in production.
COPY infra/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/live-web/dist /usr/share/nginx/html

# `RUNNER_API_HOST`/`RUNNER_API_PORT` are substituted into the template by the
# nginx entrypoint, so the image is not built against one environment.
ENV RUNNER_API_HOST=api
ENV RUNNER_API_PORT=3001

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
