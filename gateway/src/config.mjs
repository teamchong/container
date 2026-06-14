// Central config, all overridable by env so the same gateway works whether
// it runs on the host or inside the Linux container.
export const config = {
  // Port the gateway listens on. The user's harness is pointed here.
  port: Number(process.env.GATEWAY_PORT ?? 8787),

  // Default routing when the transcript carries no @local/@remote directive.
  defaultMode: process.env.GATEWAY_DEFAULT_MODE === "local" ? "local" : "remote",

  // Remote upstreams (passthrough targets), one per protocol.
  remoteAnthropicBase: trimSlash(process.env.REMOTE_ANTHROPIC_BASE ?? "https://api.anthropic.com"),
  remoteOpenAIBase: trimSlash(process.env.REMOTE_OPENAI_BASE ?? "https://api.openai.com"),

  // The host-native, Metal-accelerated llama.cpp server (llama-server), which
  // speaks the OpenAI Chat Completions API. From inside the Linux container
  // this should be the host-gateway address, e.g. http://192.168.64.1:8080.
  localLlamaBase: trimSlash(process.env.LOCAL_LLAMA_BASE ?? "http://localhost:8080"),

  // Model name advertised to / requested from the local engine.
  localModel: process.env.LOCAL_MODEL ?? "local",
};

function trimSlash(s) {
  return s.replace(/\/+$/, "");
}
