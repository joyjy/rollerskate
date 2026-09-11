import { fileURLToPath } from "node:url";

import {
  callChatTool,
  chatToolDefinitions,
  createChatToolContext
} from "../../application/chat/tool-policy.js";
import {
  runStdioMcpToolServer,
  safeMcpError
} from "./stdio-server.js";

async function main(): Promise<void> {
  const values = argumentsMap(process.argv.slice(2));
  const context = createChatToolContext({
    repoRoot: required(values, "--repo-root"),
    dispatchEventId: required(values, "--dispatch-event-id"),
    runtimeDirectory: required(values, "--runtime-directory")
  });
  await runStdioMcpToolServer({
    name: "rollerskate-chat-tools",
    version: "0.6.0",
    tools: chatToolDefinitions,
    call: (name, args) => callChatTool(context, name, args)
  });
}

function argumentsMap(argv: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--") ||
      values.has(name)) {
      throw new Error("Chat tools MCP arguments are malformed");
    }
    values.set(name, value);
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "" || value.includes("\0")) {
    throw new Error(`Chat tools MCP ${key} is required`);
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${safeMcpError(error)}\n`);
    process.exitCode = 1;
  });
}
