import { join } from "node:path";

import { callChatHistoryTool } from "../../src/entrypoints/mcp/chat-history.js";
import { LocalChatStore } from "../../src/infrastructure/sqlite/chat-store.js";

const contextEnvironment = "ROLLERSKATE_CHAT_HISTORY_CONTEXT";

export default function registerRollerskateChatHistory(pi) {
  const raw = process.env[contextEnvironment];
  if (raw === undefined) throw new Error("Rollerskate Chat history context is missing");
  const input = JSON.parse(raw);
  const store = new LocalChatStore(join(input.runtimeDirectory, "runtime.db"));
  const context = {
    store,
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
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  });
  pi.on("session_shutdown", async () => store.close());
}
