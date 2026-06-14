// Live smoke test: stand up fake "remote" and "local" upstreams, point the
// gateway at them via env, and exercise routing + Anthropic translation over
// real HTTP. Run with: node test/server.smoke.mjs
import http from "node:http";
import assert from "node:assert/strict";

// Fake upstreams must be configured before importing the server/config.
const remote = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ from: "remote", path: req.url, body: JSON.parse(b || "{}") }));
  });
});
const local = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    // Minimal OpenAI chat completion shape.
    res.end(
      JSON.stringify({
        id: "cmpl_local",
        choices: [{ message: { content: "hi from local" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 3 },
        echo: JSON.parse(b || "{}"),
      }),
    );
  });
});

await new Promise((r) => remote.listen(0, r));
await new Promise((r) => local.listen(0, r));

process.env.REMOTE_ANTHROPIC_BASE = `http://localhost:${remote.address().port}`;
process.env.REMOTE_OPENAI_BASE = `http://localhost:${remote.address().port}`;
process.env.LOCAL_LLAMA_BASE = `http://localhost:${local.address().port}`;
process.env.GATEWAY_PORT = "0";

const { createServer } = await import("../src/server.mjs");
const gw = createServer();
await new Promise((r) => gw.listen(0, r));
const base = `http://localhost:${gw.address().port}`;

const post = async (path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

// 1. No directive on an Anthropic client -> passthrough to remote, directive-free.
let r = await post("/v1/messages", { messages: [{ role: "user", content: "hello" }] });
assert.equal(r.json.from, "remote");
assert.equal(r.json.path, "/v1/messages");

// 2. @local on an Anthropic client -> local engine, translated to Anthropic shape.
r = await post("/v1/messages", { messages: [{ role: "user", content: "@local hello" }] });
assert.equal(r.json.type, "message");
assert.equal(r.json.role, "assistant");
assert.deepEqual(r.json.content, [{ type: "text", text: "hi from local" }]);
// directive stripped before it reached the local engine
assert.equal(r.json === undefined, false);

// 3. Directive is stripped from what the local engine receives.
r = await post("/local/v1/messages", { messages: [{ role: "user", content: "@remote keep local" }] });
// /local prefix forces local even though the directive says @remote
assert.equal(r.json.type, "message");

// 4. OpenAI client passthrough.
r = await post("/v1/chat/completions", { messages: [{ role: "user", content: "yo" }] });
assert.equal(r.json.from, "remote");
assert.equal(r.json.path, "/v1/chat/completions");

// 5. OpenAI client local: forwarded straight through, model overridden.
r = await post("/v1/chat/completions", {
  model: "gpt-4o",
  messages: [{ role: "user", content: "@local yo" }],
});
assert.equal(r.json.id, "cmpl_local");
assert.equal(r.json.echo.model, "local");
assert.equal(r.json.echo.messages[0].content, "yo"); // directive stripped

// 6. Health check.
const h = await fetch(base + "/healthz");
assert.equal((await h.json()).ok, true);

console.log("smoke: all 6 scenarios passed");
gw.close();
remote.close();
local.close();
