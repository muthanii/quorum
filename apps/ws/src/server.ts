/**
 * The Quorum realtime server: Hocuspocus over websockets + the internal HTTP
 * API on the same port. Authoritative for consensus resolution — clients
 * only ever write their own votes.
 */
import { Hocuspocus } from "@hocuspocus/server";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type * as Y from "yjs";

import { getDb } from "@quorum/db/client";

import { verifyBoardToken, type BoardConnectionContext } from "./auth";
import { ConsensusController } from "./consensus";
import { loadEnv } from "./env";
import { createInternalApi, type DocGateway } from "./internal-api";
import { createLogger, serializeError } from "./log";
import { PostgresPersistence } from "./persistence";
import { PresenceTracker } from "./presence";
import { createTurnRateLimiter } from "./rate-limit";
import { createStores } from "./stores";
import { TurnDispatcher, type AgentTurnJob, type TurnQueue } from "./turns";

const AGENT_TURNS_QUEUE = "agent-turns";

async function main(): Promise<void> {
  const log = createLogger({ service: "quorum-ws" });
  const env = loadEnv();

  const db = getDb();
  const stores = createStores(db, log);

  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on("error", (error) => {
    log.error("redis connection error", serializeError(error));
  });
  const queue = new Queue<AgentTurnJob>(AGENT_TURNS_QUEUE, { connection: redis });
  const turnQueue: TurnQueue = {
    async add(job) {
      await queue.add("turn", job, {
        jobId: job.turnId,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      });
    },
  };

  const presence = new PresenceTracker({ boards: stores.boards, log });
  const dispatcher = new TurnDispatcher({
    boards: stores.boards,
    queue: turnQueue,
    log,
    // Shares the queue's connection on purpose: one non-blocking EVAL per
    // turn, so a second Redis connection would buy nothing.
    limiter: createTurnRateLimiter({ redis, log }),
  });
  const consensus = new ConsensusController({
    boards: stores.boards,
    audit: stores.audit,
    presence,
    turns: dispatcher,
    log,
  });
  presence.onQuorumChange = (boardId) => {
    // Active membership changed — re-evaluate open proposals immediately so
    // clients see the quorum recalculation, not a silently moved threshold.
    consensus.scheduleEvaluation(boardId);
  };

  const docs: DocGateway = {
    async withDoc(boardId, fn) {
      const connection = await hocuspocus.openDirectConnection(boardId, { internal: true });
      try {
        let result!: ReturnType<typeof fn>;
        await connection.transact((doc: Y.Doc) => {
          result = fn(doc);
        });
        return result;
      } finally {
        connection.disconnect();
      }
    },
  };

  const internalApi = createInternalApi({
    secret: env.INTERNAL_API_SECRET,
    docs,
    boards: stores.boards,
    audit: stores.audit,
    log,
  });

  const hocuspocus = new Hocuspocus({
    name: "quorum-ws",
    port: env.WS_PORT,
    quiet: true,
    stopOnSignals: false,
    // Debounced snapshots (PostgresPersistence.onStoreDocument); every raw
    // update is still appended to yjs_updates immediately via onChange.
    debounce: 2_000,
    maxDebounce: 10_000,
    extensions: [new PostgresPersistence(stores.snapshots, log)],

    async onAuthenticate({ token, documentName, connection }) {
      try {
        const ctx = await verifyBoardToken({
          token,
          boardId: documentName,
          secret: env.AUTH_SECRET,
        });
        if (ctx.readOnly) connection.readOnly = true;
        return ctx;
      } catch (error) {
        log.warn("websocket authentication rejected", {
          boardId: documentName,
          ...serializeError(error),
        });
        throw error;
      }
    },

    async connected({ documentName, socketId, context }) {
      const ctx = context as BoardConnectionContext;
      log.info("peer connected", {
        boardId: documentName,
        userId: ctx.userId,
        role: ctx.role,
      });
      await presence.connect(documentName, socketId, ctx);
    },

    async onDisconnect({ documentName, socketId, context }) {
      const ctx = context as Partial<BoardConnectionContext>;
      log.info("peer disconnected", { boardId: documentName, userId: ctx.userId ?? null });
      await presence.disconnect(documentName, socketId);
    },

    async afterLoadDocument({ documentName, document }) {
      dispatcher.attach(documentName, document);
      await consensus.attach(documentName, document);
    },

    async afterUnloadDocument({ documentName }) {
      consensus.detach(documentName);
      dispatcher.detach(documentName);
    },

    async onRequest({ request, response }) {
      if (await internalApi.handle(request, response)) {
        // Stop the hook chain — the response is already sent.
        throw null;
      }
    },
  });

  consensus.start();
  presence.start();

  await hocuspocus.listen();
  log.info("ws server listening", { port: env.WS_PORT, queue: AGENT_TURNS_QUEUE });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    consensus.stop();
    presence.stop();
    try {
      await hocuspocus.destroy(); // closes connections, flushes onStoreDocument
      await queue.close();
      await redis.quit();
      log.info("shutdown complete", { signal });
      process.exit(0);
    } catch (error) {
      log.error("shutdown failed", serializeError(error));
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", serializeError(reason));
  });
}

main().catch((error: unknown) => {
  // Bootstrap failure (bad env, port in use, …) — structured, then exit.
  const line = JSON.stringify({
    level: "error",
    time: new Date().toISOString(),
    msg: "ws server failed to start",
    ...serializeError(error),
  });
  process.stderr.write(`${line}\n`);
  process.exit(1);
});
