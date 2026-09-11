import { fileURLToPath } from "node:url";

import {
  openChatTimelineReader,
  type ChatTimelineReader
} from "../../application/chat/query.js";
import {
  runStdioMcpToolServer,
  safeMcpError
} from "./stdio-server.js";

export interface ChatHistoryMcpContext {
  readonly history: Pick<ChatTimelineReader, "read">;
  readonly topicId: string;
  readonly initialCursor: string;
  expectedCursor: string | undefined;
  requests: number;
  returnedBytes: number;
}

export const chatHistoryToolDefinitions: readonly Record<string, unknown>[] = [{
  name: "read_chat_history",
  description: [
    "Read one bounded, chronological page of earlier messages from the current",
    "Rollerskate Topic. On the first call, pass history.beforeEventId to continue",
    "before the bounded prompt page, or omit it to start before the current message. For another older",
    "page, pass the exact beforeEventId returned by the previous result."
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      beforeEventId: { type: "string", pattern: "^evt_[A-Za-z0-9_-]+$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }
    }
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}];

export function callChatHistoryTool(
  context: ChatHistoryMcpContext,
  name: string,
  args: unknown
): unknown {
  if (name !== "read_chat_history") {
    throw new Error(`Unknown Chat history tool: ${name}`);
  }
  if (!record(args)) throw new Error("read_chat_history arguments are malformed");
  const beforeEventId = context.requests === 0
    ? args.beforeEventId ?? context.initialCursor
    : args.beforeEventId;
  const limit = args.limit === undefined ? 50 : args.limit;
  if (typeof beforeEventId !== "string" || beforeEventId.trim() === "" ||
    typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("read_chat_history arguments are malformed");
  }
  if (context.requests > 0 && beforeEventId !== context.expectedCursor) {
    throw new Error("read_chat_history cursor does not match the current bounded page");
  }
  if (context.requests >= 20) {
    throw new Error("read_chat_history exceeds twenty requests in one invocation");
  }
  const result = context.history.read(context.topicId, {
    beforeEventId,
    limit
  });
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (context.returnedBytes + bytes > 1_048_576) {
    throw new Error("read_chat_history exceeds the one MiB invocation budget");
  }
  context.requests += 1;
  context.returnedBytes += bytes;
  context.expectedCursor = result.hasEarlier ? result.beforeEventId : undefined;
  return result;
}

async function main(): Promise<void> {
  const { context, history } = serverContext(process.argv.slice(2));
  await runStdioMcpToolServer({
    name: "rollerskate-chat-history",
    version: "0.6.0",
    tools: chatHistoryToolDefinitions,
    call: (name, args) => callChatHistoryTool(context, name, args),
    close: () => history.close()
  });
}

function serverContext(argv: readonly string[]): {
  readonly context: ChatHistoryMcpContext;
  readonly history: ChatTimelineReader;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("Chat history MCP arguments are malformed");
    }
    values.set(name, value);
  }
  const runtimeDirectory = required(values, "--runtime-directory");
  const topicId = required(values, "--topic-id");
  const sourceMessageEventId = required(values, "--source-message-event-id");
  const history = openChatTimelineReader(runtimeDirectory);
  return {
    history,
    context: {
      history,
      topicId,
      initialCursor: sourceMessageEventId,
      expectedCursor: undefined,
      requests: 0,
      returnedBytes: 0
    }
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "" || value.includes("\0")) {
    throw new Error(`Chat history MCP ${key} is required`);
  }
  return value;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${safeMcpError(error)}\n`);
    process.exitCode = 1;
  });
}
