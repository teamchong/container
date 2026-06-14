#!/usr/bin/env bash
# Assemble and push an OCI *artifact* (via ORAS) that carries:
#   - the native macOS arm64 (Mach-O) llama.cpp binary, and
#   - the .gguf weights, split into independent chunk layers.
#
# This abuses OCI-as-storage: the artifact is a delivery format, not a Linux
# rootfs. The binary inside it runs natively on the macOS host with Metal — it
# is never executed inside a Linux container. Chunking the weights is what
# gives you per-layer resume + SHA-256 integrity on an interrupted pull.
#
# Usage:
#   REGISTRY=registry.example.io/gemma-4-12b TAG=v1 \
#   LLAMA_BIN=./llama-cli GGUF=./gemma-4-12b.Q4.gguf \
#   ./scripts/build-artifact.sh
set -euo pipefail

: "${REGISTRY:?set REGISTRY, e.g. registry.example.io/gemma-4-12b}"
: "${TAG:=v1}"
: "${LLAMA_BIN:?set LLAMA_BIN to the macOS arm64 llama.cpp binary}"
: "${GGUF:?set GGUF to the .gguf weights file}"
: "${CHUNK_SIZE:=512M}"

command -v oras >/dev/null || { echo "oras not found: https://oras.land"; exit 1; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo ">> splitting $(basename "$GGUF") into ${CHUNK_SIZE} chunks"
split -b "$CHUNK_SIZE" -d -a 4 "$GGUF" "$workdir/weights.gguf.part."

cp "$LLAMA_BIN" "$workdir/llama-cli"
basename "$GGUF" > "$workdir/MODEL_FILENAME"

# One layer per chunk = independent resume. Binary + manifest as their own layers.
pushd "$workdir" >/dev/null
files=(MODEL_FILENAME "llama-cli:application/vnd.llama.binary")
for part in weights.gguf.part.*; do
  files+=("${part}:application/vnd.gguf.chunk")
done

echo ">> oras push ${REGISTRY}:${TAG}"
oras push "${REGISTRY}:${TAG}" \
  --artifact-type application/vnd.llama-model.v1 \
  "${files[@]}"
popd >/dev/null

echo ">> done: ${REGISTRY}:${TAG}"
