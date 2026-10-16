import { claudeOutputArgs, claudeOutputProtocol, type ClaudeOutputRequest } from "./claude-output-stream.js";
import { webSearchPrompt } from "./web-search-policy.js";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import type { RuntimeAgentAdapter } from "../../core/runtime/handlers.js";
import { runtimeAgentEventPrompt } from "./event-prompt.js";
import { AgentProcessClient, type AgentProcessProtocol } from "./process-client.js";
import {
  finiteNonNegative,
  invocationDiagnostics,
  type ProviderInvocationDiagnostics
} from "./invocation-diagnostics.js";
import { providerPolicyObservationFromArgv } from "./provider-policy.js";
import {
  stdioMcpAllowedTools,
  stdioMcpConfig,
  type StdioMcpServer
} from "./mcp-server.js";

interface ClaudeCodeRequest extends ClaudeOutputRequest {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId?: string;
  readonly mcpServers: readonly StdioMcpServer[];
  readonly webSearch: boolean;
}

interface ClaudeCodeResult {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly structured_output?: unknown;
  readonly session_id?: unknown;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly num_turns?: unknown;
  readonly total_cost_usd?: unknown;
}

interface ClaudeCodeDecodedResponse {
  readonly providerSessionId: string;
  readonly outcome: { readonly kind: "message"; readonly body: string };
  readonly providerDiagnostics: ProviderInvocationDiagnostics;
}

export interface ClaudeCodeRuntimeAgentOptions {
  readonly executable: string;
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes?: number;
  readonly launchArgs?: readonly string[];
  readonly resolveWebSearch?: (event: AgentInputEvent | ChatDispatchEvent) => boolean;
  readonly resolveMcpServers?: (
    input: Pick<ClaudeCodeRequest, "event" | "providerSessionId">
  ) => readonly StdioMcpServer[];
}

export class ClaudeCodeRuntimeAgent implements RuntimeAgentAdapter {
  public readonly adapterId = "claude-code-runtime-json-v1";
  public readonly providerPolicy;
  public readonly workspace: string;
  readonly #process: AgentProcessClient;
  readonly #resolveWebSearch: ClaudeCodeRuntimeAgentOptions["resolveWebSearch"];
  readonly #resolveMcpServers: ClaudeCodeRuntimeAgentOptions["resolveMcpServers"];

  public constructor(options: ClaudeCodeRuntimeAgentOptions) {
    this.workspace = workspace(options.projectRoot);
    this.#resolveMcpServers = options.resolveMcpServers;
    this.#resolveWebSearch = options.resolveWebSearch;
    this.providerPolicy = providerPolicyObservationFromArgv(
      "claude-code",
      claudeCodeOptions(undefined, options.launchArgs ?? []),
      claudeCodeOptions.toString()
    );
    this.#process = new AgentProcessClient({
      adapterId: this.adapterId,
      executable: options.executable,
      args: (request) => claudeCodeArgs(
        request as ClaudeCodeRequest,
        options.launchArgs ?? []
      ),
      environment: options.environment,
      workingDirectory: this.workspace,
      timeoutMilliseconds: options.timeoutMilliseconds,
      maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
      protocol: claudeOutputProtocol(claudeCodeProtocol)
    });
  }

  public async invoke(input: Parameters<RuntimeAgentAdapter["invoke"]>[0]):
  Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    const resolutionInput = {
      event: input.event,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId })
    };
    const webSearch = input.event.type === "chat.dispatch" && this.#resolveWebSearch?.(input.event) === true;
    const result = await this.#process.invoke({
      ...resolutionInput,
      ...(input.reportOutput === undefined ? {} : {reportOutput: input.reportOutput}),
      mcpServers: this.#resolveMcpServers?.(resolutionInput) ?? [],
      webSearch
    } satisfies ClaudeCodeRequest);
    const response = result.response as ClaudeCodeDecodedResponse;
    return {
      providerSessionId: response.providerSessionId,
      outcome: response.outcome,
      invocation: invocationDiagnostics(input.event, result, response.providerDiagnostics, claudeCodeProtocol.encodeRequest({...input, mcpServers: [], webSearch}))
    };
  }
}

function claudeCodeArgs(
  request: ClaudeCodeRequest,
  launchArgs: readonly string[]
): string[] {
  const access = request.event.type === "agent.request"
    ? request.event.runContext?.workspaceGrant?.access
    : request.event.type === "subscription.fire"
      ? request.event.invocation?.workspaceGrant.access
      : undefined;
  const options = claudeOutputArgs(claudeCodeOptions(access, launchArgs, request.webSearch), request.reportOutput !== undefined);
  const mcpOptions = request.mcpServers.length === 0
    ? []
    : [
        "--mcp-config", stdioMcpConfig(request.mcpServers),
        "--strict-mcp-config"
      ];
  const allowed = [...stdioMcpAllowedTools(request.mcpServers), ...(request.webSearch ? ["WebSearch"] : [])];
  const permissions = allowed.length === 0 ? [] : ["--allowedTools", ...allowed];
  return request.providerSessionId === undefined
    ? [...options, ...mcpOptions, ...permissions]
    : [...options, ...mcpOptions, ...permissions, "--resume", request.providerSessionId];
}

function claudeCodeOptions(
  access: "read" | "write" | undefined,
  launchArgs: readonly string[],
  webSearch = false
): string[] {
  return [
    ...launchArgs,
    "--print",
    "--output-format", "json",
    ...(access === "write"
      ? ["--permission-mode", "acceptEdits", "--tools", `Read,Glob,Grep,Edit,Write,Bash${webSearch ? ",WebSearch" : ""}`]
      : ["--permission-mode", "plan", "--tools", `Read,Glob,Grep${webSearch ? ",WebSearch" : ""}`])
  ];
}

const claudeCodeProtocol: AgentProcessProtocol = {
  encodeRequest(request: unknown): string {
    const input = request as ClaudeCodeRequest;
    return [runtimeAgentEventPrompt(input.event), ...(input.event.type === "chat.dispatch" ? [webSearchPrompt(input.webSearch)] : [])].join("\n\n");
  },
  decodeResponse(output: string): ClaudeCodeDecodedResponse {
    const parsed = JSON.parse(output) as ClaudeCodeResult;
    if (parsed.type !== "result" || parsed.subtype !== "success" ||
      parsed.is_error !== false || typeof parsed.session_id !== "string" ||
      parsed.session_id.trim() === "") {
      throw new Error("Claude Code Runtime response is missing a successful Session result");
    }
    const text = typeof parsed.result === "string"
      ? parsed.result
      : JSON.stringify(parsed.structured_output ?? parsed.result);
    if (text.trim() === "") throw new Error("Claude Code Runtime response is empty");
    const tokenUsage = claudeTokenUsage(parsed);
    const turnCount = finiteNonNegative(parsed.num_turns);
    return {
      providerSessionId: parsed.session_id,
      outcome: { kind: "message", body: text },
      providerDiagnostics: {
        ...(tokenUsage === undefined ? {} : { tokenUsage }),
        ...(turnCount === undefined ? {} : { turnCount })
      }
    };
  }
};

function claudeTokenUsage(parsed: ClaudeCodeResult) {
  const inputTokens = finiteNonNegative(parsed.usage?.input_tokens);
  const outputTokens = finiteNonNegative(parsed.usage?.output_tokens);
  const cacheReadTokens = finiteNonNegative(parsed.usage?.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegative(parsed.usage?.cache_creation_input_tokens);
  const costUsd = finiteNonNegative(parsed.total_cost_usd);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd]
    .every((value) => value === undefined)) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
    ...(costUsd === undefined ? {} : { costUsd })
  };
}

function workspace(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
  const canonical = realpathSync(projectRoot);
  if (!statSync(canonical).isDirectory()) throw new Error("projectRoot must be a directory");
  return canonical;
}
