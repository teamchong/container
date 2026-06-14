// Claude Code speaks the Anthropic Messages API; the host-native llama.cpp
// server (llama-server) speaks the OpenAI Chat Completions API. These helpers
// bridge the two for LOCAL mode only — passthrough mode forwards each protocol
// straight to its own upstream untouched, so no translation is needed there.
//
// Plain text/chat translation is faithful. Tool-use translation is best-effort:
// a local 12B may handle large tool schemas poorly, and the three-way mapping
// (Anthropic tool_use ↔ OpenAI tool_calls ↔ llama.cpp grammar) is the most
// fragile part of the bridge. Streaming tool-calls are not translated in v1.

// ---------- Anthropic request -> OpenAI request ----------

export function anthropicToOpenAI(body, localModel) {
  const messages = [];

  if (body.system) {
    const sys = typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((b) => b.text ?? "").join("\n")
        : "";
    if (sys) messages.push({ role: "system", content: sys });
  }

  for (const msg of body.messages ?? []) {
    messages.push(...anthropicMessageToOpenAI(msg));
  }

  const out = {
    model: localModel,
    messages,
    stream: !!body.stream,
  };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.tools) out.tools = body.tools.map(anthropicToolToOpenAI);
  return out;
}

function anthropicMessageToOpenAI(msg) {
  const { role, content } = msg;
  if (typeof content === "string") return [{ role, content }];
  if (!Array.isArray(content)) return [{ role, content: "" }];

  const textParts = [];
  const toolCalls = [];
  const toolResults = []; // become standalone `tool` messages

  for (const block of content) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
        break;
      case "tool_result":
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: extractBlockText(block.content),
        });
        break;
      default:
        break;
    }
  }

  const out = [];
  if (role === "assistant") {
    const m = { role: "assistant", content: textParts.join("\n") || null };
    if (toolCalls.length) m.tool_calls = toolCalls;
    if (m.content !== null || m.tool_calls) out.push(m);
  } else {
    if (textParts.length) out.push({ role, content: textParts.join("\n") });
    out.push(...toolResults);
  }
  return out.length ? out : [{ role, content: "" }];
}

function extractBlockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => b.text ?? "").join("\n");
  return "";
}

function anthropicToolToOpenAI(t) {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  };
}

// ---------- OpenAI (non-stream) response -> Anthropic response ----------

export function openAIToAnthropic(resp, model) {
  const choice = resp.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function?.name,
      input: safeParse(tc.function?.arguments),
    });
  }
  return {
    id: resp.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapFinish(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------- OpenAI SSE stream -> Anthropic SSE stream (text-only, v1) ----------
//
// Stateful translator: feed parsed OpenAI delta chunks, get back Anthropic SSE
// event strings. Emits the canonical Anthropic event order:
//   message_start → content_block_start → content_block_delta* →
//   content_block_stop → message_delta → message_stop
export function createOpenAIToAnthropicStream(model) {
  let blockOpen = false;
  const enc = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  return {
    start() {
      return enc("message_start", {
        type: "message_start",
        message: {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    },
    delta(chunk) {
      const text = chunk?.choices?.[0]?.delta?.content;
      if (!text) return "";
      let out = "";
      if (!blockOpen) {
        blockOpen = true;
        out += enc("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
      }
      out += enc("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
      return out;
    },
    stop(finishReason) {
      let out = "";
      if (blockOpen) out += enc("content_block_stop", { type: "content_block_stop", index: 0 });
      out += enc("message_delta", {
        type: "message_delta",
        delta: { stop_reason: mapFinish(finishReason), stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      out += enc("message_stop", { type: "message_stop" });
      return out;
    },
  };
}

function mapFinish(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s ?? "{}");
  } catch {
    return {};
  }
}
