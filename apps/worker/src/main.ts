/**
 * Worker entrypoint: a BullMQ Worker on the "agent-turns" queue, concurrency
 * 5. The ws server enqueues jobs with attempts: 3 and exponential backoff
 * (5s base); this side mirrors those numbers to decide when a failure is
 * final and the agent must be marked degraded.
 */
import { UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";

import { markAgentDegraded, markAgentReady, type AgentHealthDeps } from "./degraded";
import { loadEnv } from "./env";
import { TurnError } from "./errors";
import { createLogger, errorFields } from "./log";
import { createPgAgentStore } from "./store";
import { processTurn, type TurnDeps, type TurnOutcome } from "./turn";

const QUEUE_NAME = "agent-turns";
const CONCURRENCY = 5;
/** Must match the enqueue-side job opts in apps/ws (attempts: 3, backoff 5s exponential). */
const DEFAULT_JOB_ATTEMPTS = 3;

const log = createLogger({ service: "quorum-worker" });

function fatal(message: string, err: unknown): never {
  log.error(message, errorFields(err));
  process.exit(1);
}

const env = (() => {
  try {
    return loadEnv();
  } catch (err) {
    fatal("environment validation failed", err);
  }
})();

// BullMQ needs its own blocking-capable connection (maxRetriesPerRequest:
// null); the idempotency SETs go over a separate plain connection.
const queueRedis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
const kvRedis = new Redis(env.redisUrl);
queueRedis.on("error", (err) => log.error("queue redis connection error", errorFields(err)));
kvRedis.on("error", (err) => log.error("kv redis connection error", errorFields(err)));

const store = createPgAgentStore();

const turnDeps: TurnDeps = {
  idempotency: {
    set: (key, value, secondsToken, seconds, nx) =>
      kvRedis.set(key, value, secondsToken, seconds, nx),
    get: (key) => kvRedis.get(key),
  },
  store,
  wsBaseUrl: env.wsInternalBaseUrl,
  internalApiSecret: env.internalApiSecret,
  log,
};

const healthDeps: AgentHealthDeps = {
  store,
  wsBaseUrl: env.wsInternalBaseUrl,
  internalApiSecret: env.internalApiSecret,
  log,
};

/** Loose pick of the ids the failed-handler needs; full validation lives in processTurn. */
const jobIdsSchema = z.object({ boardId: z.string().min(1), agentId: z.string().min(1) });

const worker = new Worker<unknown, TurnOutcome>(
  QUEUE_NAME,
  async (job) => {
    try {
      const outcome = await processTurn(job.data, String(job.id ?? job.name), turnDeps);
      if (outcome.status === "completed") {
        await markAgentReady({ boardId: outcome.boardId, agentId: outcome.agentId }, healthDeps);
      }
      return outcome;
    } catch (err) {
      // Non-retryable failures must not burn the remaining backoff attempts.
      if (err instanceof TurnError && !err.retryable) {
        throw new UnrecoverableError(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  },
  { connection: queueRedis, concurrency: CONCURRENCY },
);

worker.on("completed", (job, outcome) => {
  log.info("turn job completed", { jobId: job.id, outcome });
});

worker.on("failed", (job, err) => {
  const attemptsMade = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts.attempts ?? DEFAULT_JOB_ATTEMPTS;
  const finalFailure = err instanceof UnrecoverableError || attemptsMade >= maxAttempts;
  log.error("turn job failed", {
    jobId: job?.id,
    attemptsMade,
    maxAttempts,
    finalFailure,
    ...errorFields(err),
  });
  if (!finalFailure || job === undefined) return;
  const ids = jobIdsSchema.safeParse(job.data);
  if (!ids.success) {
    log.error("cannot mark agent degraded — job data has no ids", { jobId: job.id });
    return;
  }
  void markAgentDegraded(ids.data, healthDeps).catch((e) =>
    log.error("degraded transition crashed", errorFields(e)),
  );
});

worker.on("error", (err) => log.error("worker error", errorFields(err)));

log.info("worker started", {
  queue: QUEUE_NAME,
  concurrency: CONCURRENCY,
  wsBaseUrl: env.wsInternalBaseUrl,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown requested", { signal });
  try {
    await worker.close();
    await Promise.allSettled([queueRedis.quit(), kvRedis.quit()]);
    log.info("shutdown complete", { signal });
    process.exit(0);
  } catch (err) {
    log.error("shutdown failed", errorFields(err));
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
