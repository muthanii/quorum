# Quorum realtime server (Hocuspocus + the internal HTTP API on one port).
#
# BUILD CONTEXT IS THE REPO ROOT, not apps/ws — the image needs the lockfile,
# pnpm-workspace.yaml and packages/*, which ship raw TypeScript:
#   fly deploy --config apps/ws/fly.toml --dockerfile apps/ws/Dockerfile .

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pinned to the repo's packageManager field. Installed with npm rather than
# corepack: corepack is deprecated in Node 22+ and its signature checks fail
# on images older than the pnpm release being activated.
RUN npm install --global pnpm@9.15.4
WORKDIR /app

FROM base AS build
# pnpm fetch reads the lockfile and nothing else, so this layer stays cached
# across every source edit — only a dependency bump re-downloads anything.
COPY pnpm-lock.yaml .npmrc ./
RUN pnpm fetch
COPY . .
# No --prod: tsx is a devDependency and src/server.ts is executed as
# TypeScript, so pruning dev dependencies would remove the runtime itself.
RUN pnpm install --frozen-lockfile --prefer-offline --filter @quorum/ws...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/ws
USER node
EXPOSE 3001
# `node --import tsx` instead of the tsx CLI or `pnpm start`: this way node is
# PID 1, so Fly's SIGTERM lands on the handlers in server.ts and Hocuspocus
# gets to flush pending snapshots instead of the doc dying with the machine.
CMD ["node", "--import", "tsx", "src/server.ts"]
