#!/usr/bin/env python3
"""Minimal Quorum webhook agent -- Python 3.10+ stdlib only.

Run:   QUORUM_SIGNING_SECRET=whsec_yoursecret python3 agent_server.py
Then paste http://localhost:8787 (or your public HTTPS URL) into Quorum's
"connect an agent" card along with the same signing secret.

Quorum POSTs a TurnPayload and signs every request:
    X-Quorum-Signature: t=<unix seconds>,v1=<hex hmac-sha256 over "<t>.<rawBody>">
Verify it before trusting anything in the body.
"""

import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("PORT", "8787"))
SECRET = os.environ.get("QUORUM_SIGNING_SECRET")
TOLERANCE_SEC = 300


def verify_signature(secret: str, raw_body: bytes, header: str | None, now_sec: int | None = None) -> bool:
    if not header:
        return False
    t: int | None = None
    v1: str | None = None
    for part in header.split(","):
        key, sep, value = part.partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        if key == "t" and value.isdigit():
            t = int(value)
        elif key == "v1":
            v1 = value.lower()
    if t is None or v1 is None:
        return False
    now_sec = int(time.time()) if now_sec is None else now_sec
    if abs(now_sec - t) > TOLERANCE_SEC:
        return False
    signed = f"{t}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)  # constant-time compare


class AgentHandler(BaseHTTPRequestHandler):
    # Quorum retries a turn up to 3 times on timeout -- be idempotent on turnId.
    seen_turns: set[str] = set()

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        if not verify_signature(SECRET, raw_body, self.headers.get("X-Quorum-Signature")):
            self._send_json(401, {"error": "invalid signature"})
            return

        turn = json.loads(raw_body)  # TurnPayload
        if turn["turnId"] in self.seen_turns:
            self._send_json(200, {"messages": [], "operations": []})
            return
        self.seen_turns.add(turn["turnId"])

        # --- your agent logic goes here ---------------------------------
        # turn["trigger"]["type"]           "mention" | "broadcast" | "proposal_approved" | "schedule"
        # turn["context"]["messages"]       recent group chat
        # turn["context"]["artifacts"]      artifacts on the canvas
        # turn["context"]["openProposals"]  proposals still collecting votes
        # turn["capabilities"]              what you may do this turn
        messages = turn["context"]["messages"]
        last = messages[-1]["content"] if messages else ""
        response = {
            "messages": [{"content": f'Heard: "{last[:200]}" -- drafting a doc.'}],
            "operations": [
                {
                    "op": "artifact.create",
                    "type": "doc",
                    "title": "Draft from starter agent",
                    "content": "Replace this snippet's logic with your own agent.",
                }
            ],
        }
        # Note: operations are STAGED as proposals; the board must approve them.
        # -----------------------------------------------------------------

        self._send_json(200, response)

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:  # keep the console quiet
        pass


if __name__ == "__main__":
    if not SECRET:
        raise SystemExit(
            "Set QUORUM_SIGNING_SECRET (the signing secret Quorum shows when you connect the agent)."
        )
    print(f"Quorum agent listening on http://localhost:{PORT}")
    HTTPServer(("", PORT), AgentHandler).serve_forever()
