import http from "node:http";
import { config } from "./config.mjs";
import { resolveMode, cleanMessages } from "./routing.mjs";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  createOpenAIToAnthropicStream,
} from "./translate.mjs";

// The gateway sits between the user's harness and either the real provider
// (passthrough) or the host-native llama.cpp (local). Two client protocols are
// supported, keyed off the request path:
//   POST /v1/messages          → Anthropic shape (Claude Code)
//   POST /v1/chat/completions   → OpenAI shape   (Codex, OpenCode)
//
// A /local prefix on either path forces local mode unconditionally, ignoring
// the @local/@remote directives — this is the "always-local via a specific
// path" entry point the launcher uses for --local-only.

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendJSON(res, 502, { error: { type: "gateway_error", message: String(err?.message ?? err) } });
    });
  });
}

async function handle(req, res) {
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method !== "POST") {
    return sendJSON(res, 405, { error: { message: "method not allowed" } });
  }

  // Strip the optional /local prefix and remember it forced local mode.
  let path = new URL(req.url, "http://localhost").pathname;
  const forceLocal = path.startsWith("/local");
  if (forceLocal) path = path.slice("/local".length) || "/";

  const isAnthropic = path === "/v1/messages";
  const isOpenAI = path === "/v1/chat/completions";
  if (!isAnthropic && !isOpenAI) {
    return sendJSON(res, 404, { error: { message: `unhandled path: ${path}` } });
  }

  const body = await readJSON(req);
  const mode = forceLocal ? "local" : resolveMode(body.messages, config.defaultMode);

  // Directives are gateway instructions, never prompt content — strip always.
  body.messages = cleanMessages(body.messages);

  if (mode === "remote") {
    return proxyRemote({ req, res, body, isAnthropic });
  }
  return proxyLocal({ res, body, isAnthropic });
}

// ---------- Passthrough: forward to the real provider as-is ----------

async function proxyRemote({ req, res, body, isAnthropic }) {
  const base = isAnthropic ? config.remoteAnthropicBase : config.remoteOpenAIBase;
  const path = isAnthropic ? "/v1/messages" : "/v1/chat/completions";
  const upstream = await fetch(base + path, {
    method: "POST",
    headers: forwardHeaders(req.headers),
    body: JSON.stringify(body),
  });
  await pipeUpstream(upstream, res);
}

// ---------- Local: route to host-native llama.cpp ----------

async function proxyLocal({ res, body, isAnthropic }) {
  const wantStream = !!body.stream;

  // OpenAI-shaped clients map straight onto llama-server, no translation.
  const openAIBody = isAnthropic
    ? anthropicToOpenAI(body, config.localModel)
    : { ...body, model: config.localModel };

  const upstream = await fetch(config.localLlamaBase + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(openAIBody),
  });

  // OpenAI client + local engine: identical protocol, just stream/forward.
  if (!isAnthropic) {
    return pipeUpstream(upstream, res);
  }

  // Anthropic client: translate the llama-server (OpenAI) reply back.
  if (!wantStream) {
    const json = await upstream.json();
    return sendJSON(res, upstream.status, openAIToAnthropic(json, config.localModel));
  }
  return streamOpenAIToAnthropic(upstream, res);
}

// ---------- Streaming: OpenAI SSE -> Anthropic SSE ----------

async function streamOpenAIToAnthropic(upstream, res) {
  res.writeHead(upstream.status, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const xlate = createOpenAIToAnthropicStream(config.localModel);
  res.write(xlate.start());

  let finish = "stop";
  for await (const evt of sseEvents(upstream.body)) {
    if (evt === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(evt);
    } catch {
      continue;
    }
    const reason = chunk?.choices?.[0]?.finish_reason;
    if (reason) finish = reason;
    const out = xlate.delta(chunk);
    if (out) res.write(out);
  }
  res.write(xlate.stop(finish));
  res.end();
}

// ---------- helpers ----------

// Copy an upstream Response (streaming or not) onto the Node res unchanged.
async function pipeUpstream(upstream, res) {
  const headers = {};
  for (const [k, v] of upstream.headers) {
    if (k === "content-length" || k === "content-encoding" || k === "transfer-encoding") continue;
    headers[k] = v;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  for await (const bytes of upstream.body) res.write(bytes);
  res.end();
}

// Yield the `data:` payloads of an SSE byte stream, line by line.
async function* sseEvents(body) {
  let buf = "";
  const dec = new TextDecoder();
  for await (const bytes of body) {
    buf += dec.decode(bytes, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

// Forward auth + protocol headers to the remote provider; drop hop-by-hop ones.
function forwardHeaders(incoming) {
  const allow = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "openai-organization"];
  const out = { "content-type": "application/json" };
  for (const k of allow) {
    if (incoming[k]) out[k] = incoming[k];
  }
  return out;
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

// Start the server when run directly (the launcher imports createServer instead).
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(config.port, () => {
    console.error(`[gateway] listening on http://localhost:${config.port} (default: ${config.defaultMode})`);
  });
}
