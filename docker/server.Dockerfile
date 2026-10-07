# syntax=docker/dockerfile:1
# The API, the bot and the one-shot migration (DESIGN.md §13.2): one image,
# three commands. Node runs the TypeScript sources as they are (D22), so the
# image keeps the workspace's layout: `@dfs/*` stay links into packages/,
# since Node won't strip types from files under node_modules.
#
#   docker build -f docker/server.Dockerfile -t dfs-server .

FROM node:24-bookworm-slim
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Dependencies first, so they are installed again only when a manifest
# changes. Every workspace's manifest comes along, so the lockfile matches.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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
    pnpm install --frozen-lockfile --prod --store-dir /pnpm-store \
      --filter "@dfs/api..." --filter "@dfs/bot..."

COPY packages packages
COPY apps/api apps/api
COPY apps/bot apps/bot

# Staging (shared by the API and the bot) and the API's frame cache: a new
# named volume mounted there takes this owner.
RUN mkdir -p /data/staging /data/cache /data/blobs && chown -R node:node /data

ENV NODE_ENV=production
# The deploy's version and time (docker/deploy.sh), which every API answer
# carries and Admin → System shows. Last, so a new deploy rebuilds nothing else.
ARG DFS_VERSION=dev
ARG DFS_DEPLOYED_AT=
ENV DFS_VERSION=$DFS_VERSION DFS_DEPLOYED_AT=$DFS_DEPLOYED_AT
USER node
EXPOSE 3000 3001
CMD ["node", "apps/api/src/main.ts"]
