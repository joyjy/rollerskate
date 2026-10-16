import { webSearchPrompt } from "./web-search-policy.js";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import { AgentInvocationError } from "../../core/runtime/agent-invocation.js";
import type { ProviderPolicyObservationSnapshot } from
  "../../core/runtime/agent-invocation.js";
import type { RuntimeAgentAdapter } from "../../core/runtime/handlers.js";
import { runtimeAgentEventPrompt } from "./event-prompt.js";
import {
  agentInvocationFailure,
  agentInvocationProgress,
  countedTools,
  finiteNonNegative,
  invocationTimeoutMilliseconds,
  invocationDiagnostics,
  type ProviderInvocationDiagnostics
} from "./invocation-diagnostics.js";
import { type StdioMcpServer, validateStdioMcpServer } from "./mcp-server.js";
import { codexAppServerPolicyObservation } from "./provider-policy.js";
import { CodexAppServerRunner } from "./runner/codex-app-server.js";
import {
  RunnerInvocationError,
  runnerAssistantMessages,
  runnerToolNames,
  runnerTurnCount,
  runnerUsage,
  type RunnerTurnReceipt
} from "./runner/protocol.js";

export const CODEX_CLIENT_HISTORY_POLICY_ENV = "ROLLERSKATE_CLIENT_HISTORY_POLICY";
export const READONLY_RUN_NETWORK_GRANT_ENV = "ROLLERSKATE_READONLY_RUN_NETWORK_GRANT";

export interface CodexRuntimeAgentOptions {
  readonly executable: string;
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly meaningfulOutputTimeoutMilliseconds?: number;
  readonly maxOutputBytes?: number;
  readonly launchArgs?: readonly string[];
  readonly resolveWebSearch?: (event: AgentInputEvent | ChatDispatchEvent) => boolean;
  readonly resolveMcpServers?: (
    input: CodexMcpServerResolutionInput
  ) => readonly CodexMcpServer[];
  readonly serializeMcpPolicy?: (
    observation: ProviderPolicyObservationSnapshot & { readonly client: "codex" }
  ) => string;
}

export interface CodexMcpServerResolutionInput {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId?: string;
  readonly invocationStartedAt: string;
}

export type CodexMcpServer = StdioMcpServer;

export class CodexRuntimeAgent implements RuntimeAgentAdapter {
  public readonly adapterId = "codex-runtime-app-server-v1";
  public readonly providerPolicy;
  public readonly workspace: string;
  readonly #options: CodexRuntimeAgentOptions;
  readonly #selection: { readonly model?: string; readonly reasoningEffort?: string };

  public constructor(options: CodexRuntimeAgentOptions) {
    this.workspace = workspace(options.projectRoot);
    this.#options = options;
    this.#selection = codexSelection(options.launchArgs ?? []);
    this.providerPolicy = codexAppServerPolicyObservation(
      codexThreadParameters("read", false, this.workspace, [], this.#selection),
      codexPolicyHelperSource,
      "read"
    );
  }

  public async invoke(input: Parameters<RuntimeAgentAdapter["invoke"]>[0]):
  Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    const invocationStartedAt = new Date().toISOString();
    const resolutionInput = {
      event: input.event,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      invocationStartedAt
    } satisfies CodexMcpServerResolutionInput;
    const mcpServers = this.#options.resolveMcpServers?.(resolutionInput) ?? [];
    const access = codexWorkspaceAccess(input.event);
    const totalTimeoutMilliseconds = invocationTimeoutMilliseconds(input.event);
    const meaningfulOutputTimeoutMilliseconds =
      this.#options.meaningfulOutputTimeoutMilliseconds ??
      this.#options.timeoutMilliseconds;
    const networkAccess = codexNetworkAccess(input.event);
    const webSearch = input.event.type === "chat.dispatch" ? this.#options.resolveWebSearch?.(input.event) === true : undefined;
    const effectivePrompt = [runtimeAgentEventPrompt(input.event), ...(webSearch === undefined ? [] : [webSearchPrompt(webSearch)])].join("\n\n");
    const threadParameters = codexThreadParameters(
      access,
      networkAccess,
      this.workspace,
      mcpServers,
      this.#selection,
      webSearch
    );
    const policyObservation = codexAppServerPolicyObservation(
      threadParameters,
      codexPolicyHelperSource,
      access
    );
    const environment = codexEnvironment(
      this.#options.environment,
      mcpServers,
      policyObservation,
      this.#options.serializeMcpPolicy,
      input.event
    );
    const runner = new CodexAppServerRunner({
      adapterId: this.adapterId,
      executable: this.#options.executable,
      environment,
      workingDirectory: this.workspace,
      meaningfulOutputTimeoutMilliseconds,
      maxOutputBytes: this.#options.maxOutputBytes ?? 1_048_576,
      threadParameters,
      ...(access === "read" ? {turnSandboxPolicy: codexReadSandboxPolicy(networkAccess)} : {})
    });
    let receipt: RunnerTurnReceipt;
    try {
      receipt = await runner.invoke({
        ...(input.reportOutput === undefined ? {} : {onOutput: input.reportOutput}),
        prompt: effectivePrompt,
        workspaceAccess: access,
        totalTimeoutMilliseconds,
        meaningfulOutputTimeoutMilliseconds,
        ...(input.providerSessionId === undefined
          ? {}
          : { sessionId: input.providerSessionId }),
        ...(input.reportProgress === undefined
          ? {}
          : {
              onProgress: (progress) => input.reportProgress!(agentInvocationProgress({
                adapterId: this.adapterId,
                workspace: this.workspace,
                workspaceAccess: access,
                progress,
                ...(progress.sessionId === undefined
                  ? {}
                  : { providerSessionId: progress.sessionId })
              }))
            })
      });
    } catch (error) {
      if (!(error instanceof RunnerInvocationError)) throw error;
      throw new AgentInvocationError(error.message, agentInvocationFailure({
        adapterId: this.adapterId,
        workspace: this.workspace,
        workspaceAccess: access,
        trace: error.trace,
        ...(error.trace.sessionId === undefined
          ? {}
          : { providerSessionId: error.trace.sessionId })
      }));
    }
    const response = codexResponse(receipt);
    return {
      providerSessionId: receipt.sessionId,
      outcome: response.outcome,
      invocation: invocationDiagnostics(input.event, receipt, response.providerDiagnostics, effectivePrompt)
    };
  }
}

function codexThreadParameters(
  access: "read" | "write",
  networkAccess: boolean,
  projectRoot: string,
  servers: readonly CodexMcpServer[],
  selection: { readonly model?: string; readonly reasoningEffort?: string },
  webSearch?: boolean
): Readonly<Record<string, unknown>> {
  const mcpServers = Object.fromEntries(servers.map((server) => {
    validateStdioMcpServer(server);
    return [server.name, {
      command: server.command,
      args: server.args,
      env_vars: [CODEX_CLIENT_HISTORY_POLICY_ENV],
      startup_timeout_sec: 10,
      tool_timeout_sec: 30
    }];
  }));
  return {
    cwd: projectRoot,
    approvalPolicy: "never",
    sandbox: access === "write" ? "workspace-write" : "read-only",
    ...(selection.model === undefined ? {} : { model: selection.model }),
    config: {
      ...(webSearch === undefined ? {} : { web_search: webSearch ? "live" : "disabled" }),
      ...(selection.reasoningEffort === undefined ? {} : { model_reasoning_effort: selection.reasoningEffort }),
      shell_environment_policy: { exclude: [CODEX_CLIENT_HISTORY_POLICY_ENV, READONLY_RUN_NETWORK_GRANT_ENV] },
      ...(networkAccess
        ? { sandbox_workspace_write: { network_access: true } }
        : {}),
      ...(servers.length === 0 ? {} : { mcp_servers: mcpServers })
    }
  };
}

function codexResponse(receipt: RunnerTurnReceipt): {
  readonly outcome: { readonly kind: "message"; readonly body: string };
  readonly providerDiagnostics: ProviderInvocationDiagnostics;
} {
  const text = runnerAssistantMessages(receipt).at(-1)?.text;
  if (text === undefined || text.trim() === "") {
    throw new Error("Codex app-server response is missing final message");
  }
  const usage = runnerUsage(receipt);
  const inputTokens = finiteNonNegative(usage?.inputTokens);
  const outputTokens = finiteNonNegative(usage?.outputTokens);
  const cacheReadTokens = finiteNonNegative(usage?.cacheReadTokens);
  const totalTokens = finiteNonNegative(usage?.totalTokens);
  const tokenUsage = usage === undefined ? undefined : {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens })
  };
  const toolUsage = countedTools(runnerToolNames(receipt));
  return {
    outcome: { kind: "message", body: text },
    providerDiagnostics: {
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      ...(toolUsage.length === 0 ? {} : { toolUsage }),
      turnCount: runnerTurnCount(receipt)
    }
  };
}

function codexSelection(launchArgs: readonly string[]): { model?: string; reasoningEffort?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < launchArgs.length; index += 2) {
    const option = launchArgs[index]!;
    const value = launchArgs[index + 1];
    if (!["--model", "--reasoning-effort"].includes(option) || values.has(option) ||
      value === undefined || value.trim() === "" || value.startsWith("--")) {
      throw new Error("Codex app-server launch args only support --model <model> and --reasoning-effort <effort>, each once");
    }
    values.set(option, value);
  }
  const model = values.get("--model");
  const reasoningEffort = values.get("--reasoning-effort");
  if (reasoningEffort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort)) {
    throw new Error("Unsupported Codex reasoning effort");
  }
  return { ...(model === undefined ? {} : { model }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

function codexEnvironment(
  environment: Readonly<Record<string, string>>,
  servers: readonly CodexMcpServer[],
  observation: ProviderPolicyObservationSnapshot & { readonly client: "codex" },
  serializeMcpPolicy: CodexRuntimeAgentOptions["serializeMcpPolicy"],
  event: AgentInputEvent | ChatDispatchEvent
): Readonly<Record<string, string>> {
  const controlledEnvironment = { ...environment };
  delete controlledEnvironment[READONLY_RUN_NETWORK_GRANT_ENV];
  const grant = event.type === "agent.request" &&
    event.runContext?.workspaceGrant?.access === "read" &&
    event.runContext.workspaceGrant.networkAccess === true
    ? { [READONLY_RUN_NETWORK_GRANT_ENV]: event.runContext.runId }
    : {};
  if (servers.length === 0) return { ...controlledEnvironment, ...grant };
  if (serializeMcpPolicy === undefined) {
    throw new Error("Codex MCP policy serializer is required");
  }
  const serializedPolicy = serializeMcpPolicy(observation);
  if (serializedPolicy.trim() === "") throw new Error("Codex MCP policy is empty");
  return { ...controlledEnvironment, ...grant, [CODEX_CLIENT_HISTORY_POLICY_ENV]: serializedPolicy };
}

function codexWorkspaceAccess(
  event: AgentInputEvent | ChatDispatchEvent
): "read" | "write" {
  if (event.type === "agent.request") {
    return event.runContext?.workspaceGrant?.access ?? "read";
  }
  if (event.type === "subscription.fire") {
    return event.invocation?.workspaceGrant.access ?? "read";
  }
  return "read";
}

function codexNetworkAccess(event: AgentInputEvent | ChatDispatchEvent): boolean {
  if (event.type === "agent.request") {
    return event.runContext?.workspaceGrant?.networkAccess === true;
  }
  return event.type === "subscription.fire" && event.invocation?.networkAccess === true;
}

function codexReadSandboxPolicy(networkAccess: boolean) {
  return {type: "readOnly", networkAccess};
}

const codexPolicyHelperSource = [
  codexReadSandboxPolicy.toString(),
  codexThreadParameters.toString(),
  codexWorkspaceAccess.toString(),
  codexNetworkAccess.toString()
].join("\n");

function workspace(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
  const canonical = realpathSync(projectRoot);
  if (!statSync(canonical).isDirectory()) throw new Error("projectRoot must be a directory");
  return canonical;
}
