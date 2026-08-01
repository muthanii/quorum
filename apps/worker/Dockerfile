# Quorum agent-turn worker (BullMQ consumer on the "agent-turns" queue).
#
# BUILD CONTEXT IS THE REPO ROOT, not apps/worker — the image needs the
# lockfile, pnpm-workspace.yaml and packages/*, which ship raw TypeScript:
#   fly deploy --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile .

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
# No --prod: tsx is a devDependency and src/main.ts is executed as TypeScript,
# so pruning dev dependencies would remove the runtime itself.
RUN pnpm install --frozen-lockfile --prefer-offline --filter @quorum/worker...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/worker
USER node
# No EXPOSE: the worker never listens. It pulls jobs from Redis and pushes
# results to the ws server's internal API.
#
# `node --import tsx` instead of the tsx CLI or `pnpm start`: this way node is
# PID 1, so Fly's SIGTERM lands on the handlers in main.ts and worker.close()
# can finish the in-flight turn instead of abandoning it mid-flight.
CMD ["node", "--import", "tsx", "src/main.ts"]
