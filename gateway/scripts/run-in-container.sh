#!/usr/bin/env bash
# Run the gateway inside Apple's `container` (apple/container) instead of as a
# bare host process. This is the isolated/sandboxed deployment we discussed:
#   - the gateway runs in the Linux VM (I/O-bound, no GPU needed there),
#   - llama.cpp stays native on the host for Metal,
#   - the host harness reaches the gateway via a published port,
#   - the gateway reaches the host's llama-server via the host gateway IP.
#
# Usage:
#   scripts/run-in-container.sh
#   GATEWAY_PORT=8787 LOCAL_LLAMA_BASE=http://192.168.64.1:8080 scripts/run-in-container.sh
set -euo pipefail

IMAGE="${IMAGE:-local-gateway:dev}"
PORT="${GATEWAY_PORT:-8787}"
# Host address as seen from inside the apple/container guest. If your harness
# can't reach the gateway, or the gateway can't reach llama-server, this IP is
# the first thing to check (`container network ls` / inspect the host gateway).
HOST_LLAMA="${LOCAL_LLAMA_BASE:-http://192.168.64.1:8080}"

command -v container >/dev/null || {
  echo "Apple 'container' CLI not found — install from https://github.com/apple/container"
  exit 1
}

echo ">> building $IMAGE"
container build -t "$IMAGE" "$(dirname "$0")/.."

echo ">> running $IMAGE on :$PORT (llama-server at $HOST_LLAMA)"
exec container run --rm \
  -p "${PORT}:${PORT}" \
  -e GATEWAY_PORT="$PORT" \
  -e LOCAL_LLAMA_BASE="$HOST_LLAMA" \
  -e GATEWAY_DEFAULT_MODE="${GATEWAY_DEFAULT_MODE:-remote}" \
  -e REMOTE_ANTHROPIC_BASE="${REMOTE_ANTHROPIC_BASE:-https://api.anthropic.com}" \
  -e REMOTE_OPENAI_BASE="${REMOTE_OPENAI_BASE:-https://api.openai.com}" \
  "$IMAGE"
