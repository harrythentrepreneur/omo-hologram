#!/usr/bin/env bash
# bin/start-with-proxy.sh — boot the hotspot proxy stack AND omo with
# one command. Used by `npm run start:hotspot`.
#
# Sequence:
#   1. Spawn bin/proxy-up.sh in the background. Its output streams inline
#      so the user sees [proxy-up] log lines.
#   2. Wait for it to drop .proxy/ready (it does this AFTER patching .env
#      with the fresh tunnel URL + creds).
#   3. Exec `node server.js` in the foreground. dotenv reads the freshly
#      patched .env on boot, so the runner picks up the new proxy.
#   4. On exit (Ctrl-C or server crash) tear the proxy stack down too.
#
# We deliberately keep `npm start` unchanged — that path is for when
# you're not tethered. This wrapper is opt-in via `npm run start:hotspot`.

set -uo pipefail

ROOT="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )/.." &> /dev/null && pwd )"
cd "$ROOT"

PROXY_DIR=".proxy"
READY_MARKER="$PROXY_DIR/ready"
READY_TIMEOUT_S="${PROXY_READY_TIMEOUT:-90}"

# Allow `NODE_CMD="node --watch server.js" npm run start:hotspot` to swap
# in dev mode without us needing a parallel script.
NODE_CMD="${NODE_CMD:-node server.js}"

mkdir -p "$PROXY_DIR"
rm -f "$READY_MARKER"

# ─── 1. Boot the proxy stack ──────────────────────────────────────────
bash bin/proxy-up.sh &
PROXY_PID=$!

cleanup() {
  echo
  echo "[start-with-proxy] tearing down…"
  if kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# ─── 2. Wait for the proxy to be ready ────────────────────────────────
echo "[start-with-proxy] waiting up to ${READY_TIMEOUT_S}s for proxy stack…"
for _ in $(seq 1 "$READY_TIMEOUT_S"); do
  if [ -f "$READY_MARKER" ]; then break; fi
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "[start-with-proxy] proxy-up died before ready — see [proxy-up] output above."
    exit 1
  fi
  sleep 1
done
if [ ! -f "$READY_MARKER" ]; then
  echo "[start-with-proxy] proxy never became ready after ${READY_TIMEOUT_S}s — aborting."
  exit 1
fi
echo "[start-with-proxy] proxy ready · launching omo ($NODE_CMD)"

# ─── 3. Run the server in the foreground ──────────────────────────────
# We don't `exec` here because we still need our trap to fire on exit,
# which would be lost across exec. Instead, run normally and let the
# EXIT trap kill the proxy when node returns.
$NODE_CMD
