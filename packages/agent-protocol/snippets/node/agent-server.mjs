#!/usr/bin/env node
// Minimal Quorum webhook agent — plain Node, zero dependencies.
//
// Run:   QUORUM_SIGNING_SECRET=whsec_yoursecret node agent-server.mjs
// Then paste http://localhost:8787 (or your public HTTPS URL) into Quorum's
// "connect an agent" card along with the same signing secret.
//
// Quorum POSTs a TurnPayload and signs every request:
//   X-Quorum-Signature: t=<unix seconds>,v1=<hex hmac-sha256 over "<t>.<rawBody>">
// Verify it before trusting anything in the body.

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.QUORUM_SIGNING_SECRET;
const TOLERANCE_SEC = 300;

if (!SECRET) {
  console.error(
    "Set QUORUM_SIGNING_SECRET (the signing secret Quorum shows when you connect the agent).",
  );
  process.exit(1);
}

function verifySignature(secret, rawBody, header, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header) return false;
  let t = null;
  let v1 = null;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) t = Number(value);
    else if (key === "v1" && /^[0-9a-fA-F]+$/.test(value)) v1 = value.toLowerCase();
  }
  if (t === null || v1 === null) return false;
  if (Math.abs(nowSec - t) > TOLERANCE_SEC) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"),
    "utf8",
  );
  const provided = Buffer.from(v1, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// Quorum retries a turn up to 3 times on timeout — be idempotent on turnId.
const seenTurns = new Set();

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    if (!verifySignature(SECRET, rawBody, req.headers["x-quorum-signature"])) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid signature" }));
      return;
    }

    const turn = JSON.parse(rawBody); // TurnPayload
    if (seenTurns.has(turn.turnId)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [], operations: [] }));
      return;
    }
    seenTurns.add(turn.turnId);

    // --- your agent logic goes here -------------------------------------
    // turn.trigger.type          "mention" | "broadcast" | "proposal_approved" | "schedule"
    // turn.context.messages      recent group chat
    // turn.context.artifacts     artifacts on the canvas
    // turn.context.openProposals proposals still collecting votes
    // turn.capabilities          what you may do this turn
    const lastMessage = turn.context.messages.at(-1)?.content ?? "";
    const response = {
      messages: [{ content: `Heard: "${lastMessage.slice(0, 200)}" — drafting a doc.` }],
      operations: [
        {
          op: "artifact.create",
          type: "doc",
          title: "Draft from starter agent",
          content: "Replace this snippet's logic with your own agent.",
        },
      ],
    };
    // Note: operations are STAGED as proposals; the board must approve them.
    // --------------------------------------------------------------------

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
});

server.listen(PORT, () => {
  console.log(`Quorum agent listening on http://localhost:${PORT}`);
});
