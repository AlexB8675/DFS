# syntax=docker/dockerfile:1
# The edge (DESIGN.md §3.2): Caddy, with the Caddyfile and the web app built
# into the image, so nothing is bind-mounted from the host (SELinux, §13.2).
#
#   docker build -f docker/caddy.Dockerfile -t dfs-caddy .

FROM node:24-bookworm-slim AS web
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.node.json ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contract/package.json packages/contract/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=dfs-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter "@dfs/web..."

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @dfs/web build

FROM caddy:2-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/apps/web/dist /srv
