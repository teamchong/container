import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  createOpenAIToAnthropicStream,
} from "../src/translate.mjs";

test("anthropicToOpenAI lifts system into a system message", () => {
  const out = anthropicToOpenAI(
    { system: "be terse", messages: [{ role: "user", content: "hi" }], max_tokens: 64 },
    "local-gemma",
  );
  assert.equal(out.model, "local-gemma");
  assert.deepEqual(out.messages[0], { role: "system", content: "be terse" });
  assert.deepEqual(out.messages[1], { role: "user", content: "hi" });
  assert.equal(out.max_tokens, 64);
});

test("anthropicToOpenAI maps tool_use blocks to tool_calls", () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "t1", name: "get_weather", input: { city: "NYC" } },
          ],
        },
      ],
    },
    "local",
  );
  const m = out.messages[0];
  assert.equal(m.role, "assistant");
  assert.equal(m.tool_calls[0].function.name, "get_weather");
  assert.equal(m.tool_calls[0].function.arguments, JSON.stringify({ city: "NYC" }));
});

test("anthropicToOpenAI maps tool_result blocks to tool messages", () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "72F" }],
        },
      ],
    },
    "local",
  );
  assert.deepEqual(out.messages[0], { role: "tool", tool_call_id: "t1", content: "72F" });
});

test("openAIToAnthropic shapes a non-stream response", () => {
  const resp = {
    id: "cmpl_1",
    choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  };
  const out = openAIToAnthropic(resp, "local-gemma");
  assert.equal(out.type, "message");
  assert.equal(out.role, "assistant");
  assert.deepEqual(out.content, [{ type: "text", text: "hello world" }]);
  assert.equal(out.stop_reason, "end_turn");
  assert.equal(out.usage.input_tokens, 5);
  assert.equal(out.usage.output_tokens, 2);
});

test("openAIToAnthropic maps tool_calls to tool_use blocks", () => {
  const resp = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "c1", function: { name: "search", arguments: '{"q":"x"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const out = openAIToAnthropic(resp, "local");
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(out.content[0], {
    type: "tool_use",
    id: "c1",
    name: "search",
    input: { q: "x" },
  });
});

test("streaming translator emits the canonical Anthropic event order", () => {
  const s = createOpenAIToAnthropicStream("local-gemma");
  let buf = s.start();
  buf += s.delta({ choices: [{ delta: { content: "Hel" } }] });
  buf += s.delta({ choices: [{ delta: { content: "lo" } }] });
  buf += s.stop("stop");

  const events = [...buf.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(events, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.match(buf, /"text":"Hel"/);
  assert.match(buf, /"text":"lo"/);
});

test("streaming translator with no text still closes cleanly", () => {
  const s = createOpenAIToAnthropicStream("local");
  let buf = s.start();
  buf += s.delta({ choices: [{ delta: {} }] }); // no content
  buf += s.stop("stop");
  const events = [...buf.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  // no content_block_* because nothing was emitted
  assert.deepEqual(events, ["message_start", "message_delta", "message_stop"]);
});
