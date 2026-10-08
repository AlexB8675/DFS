# syntax=docker/dockerfile:1
# The media service (DESIGN.md §6.7): ffmpeg and ffprobe, behind a small Node
# server that only the API calls. It holds no secret. Node runs the
# TypeScript sources as they are (D22), as in the server image. Its tests run
# ffmpeg in this image too (apps/media), so they test the ffmpeg production
# runs.
#
#   docker build -f docker/media.Dockerfile -t dfs-media .

FROM node:24-trixie-slim
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Debian's ffmpeg (7.1 in trixie), with nothing it merely recommends.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Dependencies first, so they are installed again only when a manifest
# changes. Every workspace's manifest comes along, so the lockfile matches.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/media/package.json apps/media/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contract/package.json packages/contract/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=dfs-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm-store --filter "@dfs/media..."

COPY packages/shared packages/shared
COPY apps/media apps/media

ENV NODE_ENV=production
# The deploy's version (docker/deploy.sh), which its health answer carries.
# Last, so a new deploy rebuilds nothing else.
ARG DFS_VERSION=dev
ENV DFS_VERSION=$DFS_VERSION
USER node
EXPOSE 3002
CMD ["node", "apps/media/src/main.ts"]
