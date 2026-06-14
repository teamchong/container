#!/usr/bin/env bash
# Pull the model artifact, reassemble the chunked weights, and ready the native
# llama.cpp binary to run on the macOS host.
#
# ORAS gives you the resilient half for free: each chunk layer is a separate
# content-addressed blob, so an interrupted pull resumes per-chunk and every
# layer is SHA-256 verified on arrival. We just stitch the chunks back together.
#
# Usage:
#   REGISTRY=registry.example.io/gemma-4-12b TAG=v1 \
#   DEST=~/.cache/local-gateway/gemma-4-12b \
#   ./scripts/pull-artifact.sh
set -euo pipefail

: "${REGISTRY:?set REGISTRY}"
: "${TAG:=v1}"
: "${DEST:=$HOME/.cache/local-gateway/model}"

command -v oras >/dev/null || { echo "oras not found: https://oras.land"; exit 1; }

mkdir -p "$DEST"
echo ">> oras pull ${REGISTRY}:${TAG} -> ${DEST}"
oras pull "${REGISTRY}:${TAG}" --output "$DEST"

model_name="$(cat "$DEST/MODEL_FILENAME")"
echo ">> reassembling chunks -> ${model_name}"
cat "$DEST"/weights.gguf.part.* > "$DEST/$model_name"
rm -f "$DEST"/weights.gguf.part.*

chmod +x "$DEST/llama-cli"
# Downloaded Mach-O binaries are quarantined by Gatekeeper; clear it so the
# host can exec the binary. (Codesign/notarize the binary to avoid this step.)
if command -v xattr >/dev/null; then
  xattr -d com.apple.quarantine "$DEST/llama-cli" 2>/dev/null || true
fi

echo ">> ready:"
echo "   binary:  $DEST/llama-cli"
echo "   weights: $DEST/$model_name"
echo
echo "Run the host-native, Metal-accelerated server with:"
echo "   $DEST/llama-cli -m $DEST/$model_name -ngl 99 --host 0.0.0.0 --port 8080"
