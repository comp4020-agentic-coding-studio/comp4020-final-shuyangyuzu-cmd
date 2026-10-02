# syntax = docker/dockerfile:1

# Node 24 (matching mise.toml), run directly — the app is plain TypeScript
# executed via Node's built-in type stripping (see tsconfig.json), so
# there's no separate build/dist step: `node src/server.ts` is the same
# command in dev and in this image.
#
# better-sqlite3 is a native addon; this stage keeps build tools (python3,
# make, g++) around only long enough to install it, so the final image
# doesn't carry a compiler.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The Fly volume (see fly.toml) — the only storage that survives a
# restart or redeploy.
ENV DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY README.md ./README.md

EXPOSE 8080
CMD ["node", "src/server.ts"]
