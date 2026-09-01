import { fileURLToPath } from "node:url";

import {
  listCodexClientThreads,
  readCodexClientThread,
  type ClientHistoryOptions
} from "../../application/activity/client-history.js";
import {
  runStdioMcpToolServer,
  safeMcpError
} from "./stdio-server.js";

export interface ClientHistoryMcpContext {
  readonly repoRoot: string;
  readonly agentId: string;
  readonly options: ClientHistoryOptions;
  readonly now: string;
}

export function clientHistoryToolDefinitions(now: string): readonly Record<string, unknown>[] {
  return [
    {
      name: "list_client_threads",
      description: [
        "List this Codex Agent's authorized Codex threads in an exact ISO-8601 time window.",
        "For relative dates such as 昨天, use the previous Asia/Shanghai calendar day.",
        `The current invocation started at ${now}.`,
        "This is enumeration, not keyword search. Results include active and archived threads."
      ].join(" "),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["since", "until"],
        properties: {
          since: { type: "string", description: "Inclusive ISO-8601 timestamp." },
          until: { type: "string", description: "Exclusive ISO-8601 timestamp." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
        }
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: "read_client_thread",
      description: "Read bounded, redacted user/assistant messages from one opaque reference returned by list_client_threads.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["reference"],
        properties: {
          reference: { type: "string", pattern: "^codex-thread:[a-f0-9]{24}$" }
        }
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    }
  ];
}

export function callClientHistoryTool(
  context: ClientHistoryMcpContext,
  name: string,
  args: unknown
): unknown {
  const input = record(args) ? args : {};
  if (name === "list_client_threads") {
    if (typeof input.since !== "string" || typeof input.until !== "string" ||
      (input.limit !== undefined && typeof input.limit !== "number")) {
      throw new Error("list_client_threads arguments are malformed");
    }
    return listCodexClientThreads(context.repoRoot, context.agentId, {
      since: input.since,
      until: input.until,
      limit: input.limit === undefined ? 20 : input.limit
    }, context.options);
  }
  if (name === "read_client_thread") {
    if (typeof input.reference !== "string") {
      throw new Error("read_client_thread arguments are malformed");
    }
    return readCodexClientThread(
      context.repoRoot,
      context.agentId,
      input.reference,
      context.options
    );
  }
  throw new Error(`Unknown client history tool: ${name}`);
}

async function main(): Promise<void> {
  const context = serverContext(process.argv.slice(2), process.env);
  await runStdioMcpToolServer({
    name: "rollerskate-client-history",
    version: "0.5.6",
    tools: clientHistoryToolDefinitions(context.now),
    call: (name, args) => callClientHistoryTool(context, name, args)
  });
}

function serverContext(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv
): ClientHistoryMcpContext {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("Client history MCP arguments are malformed");
    }
    values.set(name, value);
  }
  const repoRoot = required(values, "--repo-root");
  const runtimeDirectory = required(values, "--runtime-directory");
  const agentId = required(values, "--agent-id");
  const invocationStartedAt = required(values, "--invocation-started-at");
  const policyEnvironmentName = required(values, "--policy-environment-name");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(policyEnvironmentName)) {
    throw new Error("Client history MCP policy environment name is invalid");
  }
  const policy = environment[policyEnvironmentName];
  if (policy === undefined) throw new Error("Client history MCP policy is missing");
  const policyReceipt = JSON.parse(policy) as NonNullable<
    ClientHistoryOptions["policyReceipt"]
  >;
  return {
    repoRoot,
    agentId,
    now: invocationStartedAt,
    options: {
      runtimeDirectory,
      policyReceipt,
      excludeSessionsStartedAtOrAfter: invocationStartedAt,
      ...(values.get("--provider-session-id") === undefined
        ? {}
        : { excludedProviderSessionId: values.get("--provider-session-id")! })
    }
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "" || value.includes("\0")) {
    throw new Error(`Client history MCP ${key} is required`);
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
