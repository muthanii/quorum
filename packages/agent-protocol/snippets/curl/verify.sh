#!/usr/bin/env bash
# Sign and verify Quorum webhook signatures from the shell (openssl + coreutils).
#
# Header format:
#   X-Quorum-Signature: t=<unix seconds>,v1=<hex hmac-sha256 over "<t>.<rawBody>">
#
# Usage:
#   ./verify.sh sign   <secret> <body-file> [timestamp]   # prints the header value
#   ./verify.sh verify <secret> <body-file> '<header>'    # prints ok / FAIL (exit code)
#
# Example — send a signed turn to a local agent, exactly like Quorum does:
#   printf '%s' '{"turnId":"trn_1","boardId":"brd_1","agent":{"id":"agt_1","name":"Tester"},"trigger":{"type":"broadcast"},"context":{"messages":[],"artifacts":[],"openProposals":[]},"capabilities":["message"]}' > /tmp/turn.json
#   sig=$(./verify.sh sign whsec_yoursecret /tmp/turn.json)
#   curl -sS -X POST http://localhost:8787 \
#     -H "Content-Type: application/json" \
#     -H "X-Quorum-Signature: $sig" \
#     --data-binary @/tmp/turn.json
#
# NOTE: the string comparison below is NOT constant-time. This script is a
# debugging aid; production verifiers should use a constant-time compare
# (see the node/python snippets or @quorum/agent-protocol/v1/signature).

set -euo pipefail

TOLERANCE_SEC=300

hmac_hex() { # <secret> <body-file> <timestamp>
  { printf '%s.' "$3"; cat "$2"; } | openssl dgst -sha256 -hmac "$1" -hex | sed 's/^.* //'
}

cmd=${1:?usage: verify.sh sign|verify <secret> <body-file> [timestamp|header]}
secret=${2:?missing secret}
body_file=${3:?missing body file}

case "$cmd" in
  sign)
    t=${4:-$(date +%s)}
    printf 't=%s,v1=%s\n' "$t" "$(hmac_hex "$secret" "$body_file" "$t")"
    ;;
  verify)
    header=${4:?missing header value (t=...,v1=...)}
    t=$(printf '%s' "$header" | tr ',' '\n' | sed -n 's/^[[:space:]]*t=//p' | head -n1)
    v1=$(printf '%s' "$header" | tr ',' '\n' | sed -n 's/^[[:space:]]*v1=//p' | head -n1)
    if [ -z "$t" ] || [ -z "$v1" ]; then
      echo "FAIL: malformed header" >&2
      exit 1
    fi
    now=$(date +%s)
    skew=$((now - t))
    [ "$skew" -lt 0 ] && skew=$((-skew))
    if [ "$skew" -gt "$TOLERANCE_SEC" ]; then
      echo "FAIL: timestamp outside ${TOLERANCE_SEC}s tolerance" >&2
      exit 1
    fi
    expected=$(hmac_hex "$secret" "$body_file" "$t")
    if [ "$expected" != "$(printf '%s' "$v1" | tr '[:upper:]' '[:lower:]')" ]; then
      echo "FAIL: signature mismatch" >&2
      exit 1
    fi
    echo ok
    ;;
  *)
    echo "unknown command: $cmd (expected sign|verify)" >&2
    exit 2
    ;;
esac
