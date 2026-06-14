# local-gateway

A transparent proxy that sits in front of the coding harness you already use
(**Claude Code**, **Codex**, **OpenCode**). By default it passes your requests
straight through to the real provider. Type **`@local`** in your prompt and it
routes to a **host-native, Metal-accelerated llama.cpp** model instead. It stays
local until you type **`@remote`**.

```
npx local-gateway claude          # passthrough by default
npx local-gateway codex
npx local-gateway opencode --local-only   # always local, never leaves the machine
```

You bring the harness; the gateway just decides where each request goes.

## How switching works

The gateway is **stateless**: it never stores a "current mode". Your harness
replays the full message history on every request, so the gateway scans that
transcript and routes on the **last `@local` / `@remote` directive** it finds.

- **Sticky** — `@local` in an early turn keeps routing local through later turns,
  because it stays the latest directive until a turn carries `@remote`.
- **Concurrency-safe** — every conversation carries its own directives, so
  parallel sessions can't clobber each other.
- **Restart-safe** — the truth lives in the transcript, not in gateway memory.

The directive is stripped from the message before it reaches any model.

## Architecture

```
   your harness (any)  ──HTTP──▶  localhost:8787   (OpenAI- or Anthropic-shaped)
                                      │
                          gateway scans transcript
                          for the last @local/@remote
                          ┌───────────┴───────────┐
                     @remote                    @local
                        │                           │
              real provider API            host-native llama.cpp
           (api.anthropic.com /            (Metal, OpenAI-compatible
            api.openai.com)                 llama-server on :8080)
```

Why the local engine runs on the **host**, not in a container: Apple's
Virtualization framework does not expose Metal/the GPU to Linux guests, so
llama.cpp inside `apple/container` would be CPU-only. The GPU math therefore
runs natively; the container (if used) only needs to host this I/O-bound gateway.

### Two client protocols

| Path | Client | Remote upstream | Local |
|------|--------|-----------------|-------|
| `POST /v1/messages` | Claude Code (Anthropic) | `api.anthropic.com` | translated → llama-server |
| `POST /v1/chat/completions` | Codex / OpenCode (OpenAI) | `api.openai.com` | forwarded → llama-server |

A `/local` path prefix (used by `--local-only`) forces local mode regardless of
directives.

> **Tool-use in local mode is best-effort.** Plain chat/completions translate
> faithfully; complex tool schemas from Claude Code may not map cleanly onto a
> small local model, and streaming tool-calls are not translated in v1.

## Delivering the model: OCI artifact, not a container image

`scripts/build-artifact.sh` / `pull-artifact.sh` ship the model the
"container-registry-as-data-truck" way — but as an **OCI artifact via ORAS**,
not a runnable Linux image. The artifact carries:

- the **native macOS arm64 (Mach-O) llama.cpp binary** — runs on the host, never
  in a VM, so it keeps full Metal acceleration;
- the **`.gguf` weights split into chunk layers** — per-chunk resume on dropped
  connections and SHA-256 integrity on every layer.

```bash
REGISTRY=registry.example.io/gemma-4-12b TAG=v1 \
  LLAMA_BIN=./llama-cli GGUF=./gemma-4-12b.Q4.gguf scripts/build-artifact.sh

REGISTRY=registry.example.io/gemma-4-12b TAG=v1 scripts/pull-artifact.sh
```

The pull script reassembles the chunks and clears the Gatekeeper quarantine
attribute. Codesign/notarize the binary to skip that step.

## Configuration

All env vars, all optional:

| Var | Default | Meaning |
|-----|---------|---------|
| `GATEWAY_PORT` | `8787` | Port the gateway listens on |
| `GATEWAY_DEFAULT_MODE` | `remote` | Routing when no directive is present |
| `REMOTE_ANTHROPIC_BASE` | `https://api.anthropic.com` | Anthropic passthrough target |
| `REMOTE_OPENAI_BASE` | `https://api.openai.com` | OpenAI passthrough target |
| `LOCAL_LLAMA_BASE` | `http://localhost:8080` | Host-native llama-server |
| `LOCAL_MODEL` | `local` | Model name used with the local engine |

In passthrough mode the gateway relays your real API key to the provider; in
local mode no key is needed.

## Development

```bash
npm test          # routing + translation unit tests (node --test)
npm start         # run just the gateway (without launching a harness)
```
