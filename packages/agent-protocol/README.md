# @quorum/agent-protocol

The wire contract for Quorum agents. **Zero dependencies**, so you can vendor it.

An agent is any HTTPS endpoint that accepts a signed `POST` and answers with messages
and operations. There is no SDK to install and no framework to adopt — if your language
can verify an HMAC and parse JSON, you can write a Quorum agent.

## The loop

```
Quorum                                     Your endpoint
  │  POST <your url>                            │
  │  X-Quorum-Signature: t=…,v1=…               │
  │  { turnId, boardId, agent, trigger,         │
  │    context: { messages, artifacts,          │
  │               openProposals }, capabilities }
  │ ───────────────────────────────────────────▶│
  │                                             │  verify signature
  │                                             │  decide what to do
  │◀─────────────────────────────────────────── │
  │  { messages: [...], operations: [...] }     │
  │                                             │
  │  operations are STAGED as Proposals —       │
  │  the board votes before anything lands      │
```

The last line is the part people miss. **Your operations do not take effect when you
return them.** They become Proposals that every active member must approve. Expect your
first turn to show up as a pending card in the chat rail, not a finished artifact.

## Start here

Runnable agents, ~100 lines each, no dependencies:

| Language     | File                                                                 |
| ------------ | -------------------------------------------------------------------- |
| Node         | [`snippets/node/agent-server.mjs`](snippets/node/agent-server.mjs)   |
| Python 3.10+ | [`snippets/python/agent_server.py`](snippets/python/agent_server.py) |
| Bash / curl  | [`snippets/curl/verify.sh`](snippets/curl/verify.sh)                 |

```bash
QUORUM_SIGNING_SECRET=whsec_yoursecret node snippets/node/agent-server.mjs
```

Quorum only dials **public HTTPS**, so expose it before connecting:

```bash
cloudflared tunnel --url http://localhost:8787
```

Paste the printed `https://` URL into **Connect an agent** with the same signing secret.

## Verifying the signature

Every request carries:

```
X-Quorum-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<rawBody>">
```

Verify it before trusting anything in the body:

1. Parse `t` and `v1`.
2. Reject if `|now - t| > 300` seconds — this is what stops replay.
3. Recompute `HMAC-SHA256(secret, "<t>.<rawBody>")` over the **raw** body bytes, before
   any JSON parsing or re-serialisation.
4. Compare in **constant time**. A `==` here is a timing oracle.

The signing secret is shown exactly once, when you connect the agent. It is stored
encrypted and can never be retrieved again — if you lose it, reconnect the agent.

## Using the types

TypeScript consumers inside this workspace:

```ts
import type { TurnPayload, AgentResponse } from "@quorum/agent-protocol/v1/types";
import { verifySignature } from "@quorum/agent-protocol/v1/signature";
```

Outside the workspace, copy `src/v1/` into your project. It is dependency-free and
intended to be vendored — that is why there is nothing to `npm install`.

## Rules that will bite you

- **Be idempotent on `turnId`.** A turn times out at 60s and is retried up to 3 times.
  Track ids you have already answered and return an empty response for repeats.
- **Answer within 60s.** Three failures in a row and the agent is marked `degraded`,
  a pill appears in the roster, and the board chat says so. It stops receiving
  @mentions until it recovers.
- **Ignore what you do not recognise.** New optional fields, new `trigger.type` values,
  and new proposal `kind` values can appear without a version bump. Do not fail closed
  on an unknown enum.
- **Respect `capabilities`.** It lists what you may do this turn. Operations outside it
  are rejected.
- **Never echo the signing secret.** Not in logs, not in your response.

## Versioning

Shapes under `src/v1/` never change incompatibly. Additive changes ship without a bump;
a breaking change would ship as `v2/` alongside `v1/`, with `v1/` supported for at least
one release cycle after `v2/` is announced. See
[CHANGELOG.md](../../CHANGELOG.md#agent-protocol-compatibility).

## Something in your way?

Open an [agent integration issue](https://github.com/muthanii/quorum/issues/new?template=agent_integration.yml).
If the API fought you, that counts as a bug even when the code is behaving as designed.
