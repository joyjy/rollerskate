import { createHash } from "node:crypto";

import { queryChatReadTool } from "./read-tool-query.js";

export type ChatReadToolName =
  | "describe_capabilities"
  | "subscription_history"
  | "get_run"
  | "event_trace";

export interface ChatReadToolDefinition extends Readonly<Record<string, unknown>> {
  readonly name: ChatReadToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
    readonly openWorldHint: false;
  };
}

export interface ChatReadToolContext {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  requests: number;
  returnedBytes: number;
}

export interface ChatReadToolRequest {
  readonly schema: "ChatReadToolRequest@1";
  readonly tool: ChatReadToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ChatReadToolGrant {
  readonly schema: "ChatReadToolGrant@1";
  readonly tools: readonly ChatReadToolName[];
  readonly manifestDigest: string;
}

export type ChatReadToolCapability = ReturnType<typeof chatReadToolCapability>;

const MAX_REQUESTS = 20;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_TOTAL_BYTES = 1_048_576;

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

export const chatReadToolDefinitions: readonly ChatReadToolDefinition[] = [
  {
    name: "describe_capabilities",
    description: "Describe the safe, read-only Rollerskate tools available in this Chat turn.",
    inputSchema: emptyObjectSchema(),
    annotations
  },
  {
    name: "subscription_history",
    description: [
      "Read bounded fire, Agent execution, result, and Delivery evidence for one exact",
      "Rollerskate Subscription ID or unique prefix of at least eight hex digits. It never changes",
      "or retries the Subscription."
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["subscriptionId"],
      properties: {
        subscriptionId: { type: "string", maxLength: 64 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
      }
    },
    annotations
  },
  {
    name: "get_run",
    description: [
      "Read a bounded, redacted status and execution trace for one exact Rollerskate Run ID.",
      "Workspace contents, raw prompts, raw outputs, and control actions are not exposed."
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string", pattern: "^run_[A-Za-z0-9_-]+$" }
      }
    },
    annotations
  },
  {
    name: "event_trace",
    description: [
      "Read bounded, redacted lifecycle and causality evidence for one exact Rollerskate Event ID.",
      "This tool cannot write, replay, retry, or resolve the Event."
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["eventId"],
      properties: {
        eventId: { type: "string", pattern: "^evt_[A-Za-z0-9_-]+$" }
      }
    },
    annotations
  }
];

const toolNames = new Set(chatReadToolDefinitions.map(({ name }) => name));

export function createChatReadToolContext(input: {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
}): ChatReadToolContext {
  return {
    repoRoot: input.repoRoot,
    ...(input.runtimeDirectory === undefined
      ? {}
      : { runtimeDirectory: input.runtimeDirectory }),
    requests: 0,
    returnedBytes: 0
  };
}

export function callChatReadTool(
  context: ChatReadToolContext,
  name: string,
  args: unknown
): unknown {
  if (!isChatReadToolName(name)) throw new Error(`Unknown Chat read tool: ${name}`);
  if (context.requests >= MAX_REQUESTS) {
    throw new Error("Chat read tools exceed twenty requests in one invocation");
  }
  context.requests += 1;
  const result = execute(context, name, args);
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > MAX_RESPONSE_BYTES) {
    throw new Error("Chat read tool result exceeds the 256 KiB response budget");
  }
  if (context.returnedBytes + bytes > MAX_TOTAL_BYTES) {
    throw new Error("Chat read tools exceed the one MiB invocation budget");
  }
  context.returnedBytes += bytes;
  return result;
}

export function parseChatReadToolRequest(value: string): ChatReadToolRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!record(parsed) || parsed.schema !== "ChatReadToolRequest@1") return undefined;
  if (Object.keys(parsed).some((key) =>
    key !== "schema" && key !== "tool" && key !== "arguments") ||
    !isChatReadToolName(parsed.tool) || !record(parsed.arguments)) {
    throw new Error("ChatReadToolRequest@1 is malformed");
  }
  return {
    schema: "ChatReadToolRequest@1",
    tool: parsed.tool,
    arguments: parsed.arguments
  };
}

export function chatReadToolCapability(mode: "tools" | "request") {
  return mode === "tools"
    ? {
        schema: "ChatReadToolsCapability@1" as const,
        tools: chatReadToolDefinitions.map(({ name }) => name)
      }
    : {
        schema: "ChatReadRequestCapability@1" as const,
        tools: chatReadToolDefinitions.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      };
}

export function chatReadToolGrant(): ChatReadToolGrant {
  return {
    schema: "ChatReadToolGrant@1",
    tools: chatReadToolDefinitions.map(({ name }) => name),
    manifestDigest: createHash("sha256")
      .update(JSON.stringify(chatReadToolDefinitions))
      .digest("hex")
  };
}

function execute(
  context: ChatReadToolContext,
  name: ChatReadToolName,
  args: unknown
): unknown {
  if (name === "describe_capabilities") {
    requireArguments(args, []);
    return {
      schemaVersion: "ChatReadCapabilities@1",
      authority: "read_only",
      mutationAllowed: false,
      limits: {
        requestsPerInvocation: MAX_REQUESTS,
        responseBytes: MAX_RESPONSE_BYTES,
        totalBytesPerInvocation: MAX_TOTAL_BYTES
      },
      tools: chatReadToolDefinitions.map(({ name: tool, description, inputSchema }) => ({
        name: tool,
        description,
        inputSchema
      }))
    };
  }
  if (name === "subscription_history") {
    const input = requireArguments(args, ["subscriptionId"], ["limit"]);
    const subscriptionId = boundedString(input, "subscriptionId", 64);
    const limit = boundedInteger(input.limit, 20, 1, 50, "subscription history limit");
    return queryChatReadTool(context, {
      tool: name,
      subscriptionId,
      limit
    });
  }
  if (name === "get_run") {
    const input = requireArguments(args, ["runId"]);
    const runId = requiredIdentifier(input, "runId", "run_");
    return executeQuery(name, () => queryChatReadTool(context, {
      tool: name,
      runId
    }));
  }
  const input = requireArguments(args, ["eventId"]);
  const eventId = requiredIdentifier(input, "eventId", "evt_");
  return executeQuery(name, () => queryChatReadTool(context, {
    tool: name,
    eventId
  }));
}

function executeQuery(name: ChatReadToolName, query: () => unknown): unknown {
  try {
    return query();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^(Event|Run|Subscription) not found: (evt|run|sub)_[A-Za-z0-9_-]+$/u
      .test(message)) {
      throw new Error(message);
    }
    throw new Error(`Chat read tool ${name} query failed`);
  }
}

function requireArguments(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Readonly<Record<string, unknown>> {
  if (!record(value)) throw new Error("Chat read tool arguments are malformed");
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) ||
    required.some((key) => !(key in value))) {
    throw new Error("Chat read tool arguments are malformed");
  }
  return value;
}

function requiredIdentifier(
  value: Readonly<Record<string, unknown>>,
  key: string,
  prefix: string
): string {
  const result = value[key];
  if (typeof result !== "string" ||
    !new RegExp(`^${prefix}[A-Za-z0-9_-]+$`, "u").test(result)) {
    throw new Error(`Chat read tool ${key} is malformed`);
  }
  return result;
}

function boundedString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number
): string {
  const result = value[key];
  if (typeof result !== "string" || result.length > maximum) {
    throw new Error(`Chat read tool ${key} is malformed`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) ||
    value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function emptyObjectSchema(): Readonly<Record<string, unknown>> {
  return { type: "object", additionalProperties: false, properties: {} };
}

function isChatReadToolName(value: unknown): value is ChatReadToolName {
  return typeof value === "string" && toolNames.has(value as ChatReadToolName);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
