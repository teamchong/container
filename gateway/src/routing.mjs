// Mode resolution is derived entirely from the conversation transcript so the
// gateway can stay stateless. The harness (Claude Code / Codex / OpenCode)
// replays the full message history on every request, so the *last*
// @local / @remote directive in that history is the single source of truth.
//
// Deriving the mode this way buys three properties for free:
//   - sticky: an @local in turn 3 keeps routing local through turns 4, 5, 6…
//     because that token remains the latest directive until a later turn
//     carries @remote.
//   - concurrency-safe: every conversation carries its own directives, so
//     parallel sessions hitting the same gateway can't clobber each other.
//   - restart-safe: there is no in-memory mode to lose if the gateway restarts.

const DIRECTIVE_RE_G = /@(local|remote)\b/gi;

// Pull plain text out of a message `content`, which may be a bare string, an
// Anthropic-style block array, or an OpenAI-style parts array.
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join(" ");
  }
  return "";
}

// Scan user turns in order; the last directive seen wins. Falls back to
// `defaultMode` when the transcript carries no directive at all.
export function resolveMode(messages, defaultMode = "remote") {
  let mode = defaultMode;
  for (const msg of messages ?? []) {
    if (!msg || msg.role !== "user") continue;
    const matches = extractText(msg.content).match(DIRECTIVE_RE_G);
    if (matches && matches.length) {
      mode = matches[matches.length - 1].toLowerCase().includes("local")
        ? "local"
        : "remote";
    }
  }
  return mode;
}

// Remove directive tokens from a single content value, preserving its shape.
// The directive is an instruction to the gateway, not part of the prompt, so
// it must never reach the model (local or remote).
export function stripDirectives(content) {
  const clean = (s) => s.replace(DIRECTIVE_RE_G, "").replace(/\s{2,}/g, " ").trim();
  if (typeof content === "string") return clean(content);
  if (Array.isArray(content)) {
    return content.map((part) =>
      part && typeof part.text === "string" ? { ...part, text: clean(part.text) } : part,
    );
  }
  return content;
}

// Return a copy of `messages` with directive tokens stripped from user turns.
export function cleanMessages(messages) {
  return (messages ?? []).map((msg) =>
    msg && msg.role === "user" ? { ...msg, content: stripDirectives(msg.content) } : msg,
  );
}
