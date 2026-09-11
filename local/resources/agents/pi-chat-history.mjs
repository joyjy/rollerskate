import { join } from "node:path";

import { callChatHistoryTool } from "../../src/entrypoints/mcp/chat-history.js";
import {
  callChatTool,
  chatToolDefinitions,
  createChatToolContext
} from "../../src/application/chat/tool-policy.js";
import { LocalChatStore } from "../../src/infrastructure/sqlite/chat-store.js";

const contextEnvironment = "ROLLERSKATE_CHAT_TOOL_CONTEXT";

export default function registerRollerskateChatTools(pi) {
  const raw = process.env[contextEnvironment];
  if (raw === undefined) throw new Error("Rollerskate Chat tool context is missing");
  const input = JSON.parse(raw);
  const stores = [];
  if (input.sourceMessageEventId !== undefined) {
    const store = new LocalChatStore(join(input.runtimeDirectory, "runtime.db"));
    stores.push(store);
    const context = {
      history: store,
      topicId: input.topicId,
      initialCursor: input.sourceMessageEventId,
      expectedCursor: undefined,
      requests: 0,
      returnedBytes: 0
    };
    pi.registerTool({
      name: "read_chat_history",
      label: "Read Rollerskate Chat history",
      description: "Read a bounded older page from the current Rollerskate Topic. On the first call, pass history.beforeEventId to continue before the prompt page, or omit it to start before the current message. Chain later calls with the returned beforeEventId.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          beforeEventId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      },
      async execute(_toolCallId, params) {
        const result = callChatHistoryTool(context, "read_chat_history", params);
        return toolResult(result);
      }
    });
  }
  if (input.repoRoot !== undefined) {
    const context = createChatToolContext({
      repoRoot: input.repoRoot,
      dispatchEventId: input.dispatchEventId,
      runtimeDirectory: input.runtimeDirectory
    });
    for (const definition of chatToolDefinitions) {
      pi.registerTool({
        name: definition.name,
        label: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        async execute(_toolCallId, params) {
          return toolResult(callChatTool(context, definition.name, params));
        }
      });
    }
  }
  pi.on("session_shutdown", async () => {
    for (const store of stores) store.close();
  });
}

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result
  };
}
