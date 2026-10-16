import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import { evaluateJev, readJevKey } from "../../integrations/jev/client.js";
import type { StdioMcpServer } from "../../integrations/agent/mcp-server.js";
import { fileURLToPath } from "node:url";

export const jevTool = {
  name: "evaluate_jev",
  description: "Evaluate non-sensitive state using typed Choice, Noul or Score questions. Remove real sensitive information before calling. Preserve the raw response, actual model and question version in Run outputs. Results do not grant execution authority. Failures are not negative judgments.",
  inputSchema: { type: "object", required: ["state", "questions"], additionalProperties: false,
    properties: { state: {}, questions: { type: "object", minProperties: 1, maxProperties: 32 }, model: { type: "string" } } }
};
export function callJevTool(keyFile: string, name: string, args: unknown, signal?: AbortSignal) {
  if (name !== jevTool.name) throw new Error("Unknown Jev tool");
  return evaluateJev(args, { key: () => readJevKey(keyFile), ...(signal ? { signal } : {}) });
}
export function jevMcpServers(event: AgentInputEvent | ChatDispatchEvent, keyFile: string): StdioMcpServer[] {
  if (event.type !== "agent.request" || event.runContext?.workspaceGrant?.networkAccess !== true) return [];
  return [{ name: "rollerskate_jev", command: process.execPath, tools: [jevTool.name],
    args: [fileURLToPath(new URL("../../entrypoints/mcp/jev.js", import.meta.url)), keyFile] }];
}
