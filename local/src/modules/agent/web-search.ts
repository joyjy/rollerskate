import type { AgentClient } from "./client-profile.js";

export function nativeWebSearchCapability(client: AgentClient) {
  switch (client) {
    case "codex": return { supported: true, tool: "web_search", reason: "Uses Codex native live search" };
    case "claude-code": return { supported: true, tool: "WebSearch", reason: "Uses the client's native WebSearch tool" };
    case "kimi-code": return { supported: false, tool: null, reason: "This Kimi ACP connection has no verified per-turn search switch" };
    case "pi": return { supported: true, tool: "web_search", reason: "Uses Exa through pi-web-access" };
  }
}
