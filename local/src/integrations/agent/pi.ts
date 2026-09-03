import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import type { RuntimeAgentAdapter } from "../../core/runtime/handlers.js";
import { runtimeAgentEventPrompt } from "./event-prompt.js";
import {
  agentInvocationFailure,
  agentInvocationProgress,
  BoundedToolUsage,
  finiteNonNegative,
  invocationTimeoutMilliseconds,
  invocationDiagnostics,
  type ProviderInvocationDiagnostics
} from "./invocation-diagnostics.js";
import { AgentInvocationError } from "../../core/runtime/agent-invocation.js";
import { providerPolicyObservationFromArgv } from "./provider-policy.js";
import { PiRpcRunner } from "./runner/pi-rpc.js";
import {
  runnerAssistantMessages,
  runnerToolNames,
  runnerTurnCount,
  runnerUsage,
  RunnerInvocationError,
  type RunnerTurnReceipt,
  type RunnerUsage
} from "./runner/protocol.js";

interface PiRequest {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId: string;
  readonly chatToolContext?: PiChatToolContext;
}

interface PiDecodedResponse {
  readonly providerSessionId: string;
  readonly outcome: { readonly kind: "message"; readonly body: string };
  readonly providerDiagnostics: ProviderInvocationDiagnostics;
}

export interface PiRuntimeAgentOptions {
  readonly executable: string;
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly meaningfulOutputTimeoutMilliseconds?: number;
  readonly maxOutputBytes?: number;
  readonly launchArgs?: readonly string[];
  readonly resolveChatToolContext?: (
    input: Pick<PiRequest, "event" | "providerSessionId">
  ) => PiChatToolContext | undefined;
  readonly chatReadToolGrant?: {
    readonly tools: readonly string[];
    readonly manifestDigest: string;
  };
}

export interface PiChatToolContext {
  readonly repoRoot?: string;
  readonly runtimeDirectory: string;
  readonly topicId: string;
  readonly sourceMessageEventId?: string;
}

export const PI_CHAT_TOOL_CONTEXT_ENV = "ROLLERSKATE_CHAT_TOOL_CONTEXT";
export const PI_GIT_WORKSPACE_ENV = "ROLLERSKATE_GIT_WORKSPACE";

const piChatHistoryExtension = fileURLToPath(new URL(
  "../../../resources/agents/pi-chat-history.mjs",
  import.meta.url
));

const piReadonlyGitExtension = fileURLToPath(new URL(
  "../../../resources/agents/pi-readonly-git.mjs",
  import.meta.url
));

export class PiRuntimeAgent implements RuntimeAgentAdapter {
  public readonly adapterId: string;
  public readonly providerPolicy;
  public readonly workspace: string;
  readonly #launchArgs: readonly string[];
  readonly #processOptions: Omit<PiRuntimeAgentOptions, "resolveChatToolContext">;
  readonly #resolveChatToolContext: PiRuntimeAgentOptions["resolveChatToolContext"];
  readonly #chatReadToolNames: readonly string[];
  readonly #chatReadToolManifestDigest: string;

  public constructor(options: PiRuntimeAgentOptions) {
    this.workspace = workspace(options.projectRoot);
    this.#launchArgs = [...(options.launchArgs ?? [])];
    this.#resolveChatToolContext = options.resolveChatToolContext;
    const grant = validatedChatReadToolGrant(options.chatReadToolGrant);
    this.#chatReadToolNames = grant.tools;
    this.#chatReadToolManifestDigest = grant.manifestDigest;
    const resources = piPolicyResources(
      this.#chatReadToolNames,
      this.#chatReadToolManifestDigest
    );
    this.providerPolicy = providerPolicyObservationFromArgv(
      "pi",
      piOptions(undefined, this.#launchArgs),
      piPolicyHelperSource,
      resources
    );
    this.adapterId = `pi-runtime-rpc-v1:${this.providerPolicy.hook.helperDigest}`;
    this.#processOptions = options;
  }

  public async invoke(input: Parameters<RuntimeAgentAdapter["invoke"]>[0]):
  Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    const resolutionInput: PiRequest = {
      event: input.event,
      providerSessionId: input.providerSessionId ?? randomUUID()
    };
    const chatToolContext = this.#resolveChatToolContext?.(resolutionInput);
    const request = {
      ...resolutionInput,
      ...(chatToolContext === undefined
        ? {}
        : { chatToolContext })
    } satisfies PiRequest;
    const access = piWorkspaceAccess(request.event);
    const totalTimeoutMilliseconds = invocationTimeoutMilliseconds(input.event);
    const meaningfulOutputTimeoutMilliseconds =
      this.#processOptions.meaningfulOutputTimeoutMilliseconds ??
      this.#processOptions.timeoutMilliseconds;
    const resources = piPolicyResources(
      this.#chatReadToolNames,
      this.#chatReadToolManifestDigest
    );
    const currentBasePolicy = providerPolicyObservationFromArgv(
      "pi",
      piOptions(undefined, this.#launchArgs),
      piPolicyHelperSource,
      resources
    );
    if (currentBasePolicy.hook.helperDigest !== this.providerPolicy.hook.helperDigest) {
      throw new Error("pi bundled extension content changed; restart the Runtime");
    }
    providerPolicyObservationFromArgv(
      "pi",
      piArgs(request, this.#launchArgs, this.#chatReadToolNames),
      piPolicyHelperSource,
      resources,
      access
    );
    const process = new PiRpcRunner({
      adapterId: this.adapterId,
      executable: this.#processOptions.executable,
      args: piArgs(request, this.#launchArgs, this.#chatReadToolNames),
      environment: {
        ...this.#processOptions.environment,
        [PI_GIT_WORKSPACE_ENV]: this.workspace,
        ...(request.chatToolContext === undefined
          ? {}
          : { [PI_CHAT_TOOL_CONTEXT_ENV]: JSON.stringify(request.chatToolContext) })
      },
      workingDirectory: this.workspace,
      meaningfulOutputTimeoutMilliseconds,
      maxOutputBytes: this.#processOptions.maxOutputBytes ?? 1_048_576
    });
    let result: RunnerTurnReceipt;
    try {
      result = await process.invoke({
        prompt: runtimeAgentEventPrompt(request.event),
        sessionId: request.providerSessionId,
        workspaceAccess: access,
        totalTimeoutMilliseconds,
        meaningfulOutputTimeoutMilliseconds,
        ...(input.reportProgress === undefined
          ? {}
          : {
              onProgress: (progress) => input.reportProgress!(agentInvocationProgress({
                adapterId: this.adapterId,
                workspace: this.workspace,
                workspaceAccess: access,
                progress,
                providerSessionId: request.providerSessionId
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
        providerSessionId: request.providerSessionId
      }));
    }
    const response = piResponse(result);
    return {
      providerSessionId: response.providerSessionId,
      outcome: response.outcome,
      invocation: invocationDiagnostics(input.event, result, response.providerDiagnostics)
    };
  }
}

function piArgs(
  request: PiRequest,
  launchArgs: readonly string[],
  chatReadToolNames: readonly string[] = []
): string[] {
  const access = piWorkspaceAccess(request.event);
  const chatToolNames = request.chatToolContext === undefined
    ? []
    : [
        ...(request.chatToolContext.sourceMessageEventId === undefined
          ? []
          : ["read_chat_history"]),
        ...chatReadToolNames
      ];
  return [
    ...piOptions(
      access,
      launchArgs,
      chatToolNames
    ),
    "--session-id", request.providerSessionId
  ];
}

function piWorkspaceAccess(
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

function piOptions(
  access: "read" | "write" | undefined,
  launchArgs: readonly string[],
  chatToolNames: readonly string[] = []
): string[] {
  rejectPiResourceLaunchArgs(launchArgs);
  return [
    ...launchArgs,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--mode", "rpc",
    ...(access !== "write" ? ["--extension", piReadonlyGitExtension] : []),
    ...(chatToolNames.length > 0 ? ["--extension", piChatHistoryExtension] : []),
    "--tools", access === "write"
      ? ["read", "write", "edit", "bash", "grep", "find", "ls", ...chatToolNames].join(",")
      : ["read", "grep", "find", "ls", "read_git_diff", ...chatToolNames].join(",")
  ];
}

function rejectPiResourceLaunchArgs(launchArgs: readonly string[]): void {
  const controlled = new Set([
    "-e", "--extension", "--skill", "--prompt-template", "--theme", "--use-theme",
    "--system-prompt", "--append-system-prompt"
  ]);
  if (launchArgs.some((argument) => {
    const option = argument.startsWith("--") ? argument.split("=", 1)[0]! : argument;
    return controlled.has(option);
  })) {
    throw new Error("pi resource and prompt loading is controlled by the Runtime adapter");
  }
}

function piResponse(receipt: RunnerTurnReceipt): PiDecodedResponse {
  const text = runnerAssistantMessages(receipt).at(-1)?.text;
  if (text === undefined || text.trim() === "") {
    throw new Error("pi Runtime response is empty");
  }
  const tools = new BoundedToolUsage();
  for (const name of runnerToolNames(receipt)) tools.record(name);
  if (!receipt.toolEventsComplete) tools.invalidate();
  const toolUsage = tools.result();
  const tokenUsage = piTokenUsage(runnerUsage(receipt));
  const turnCount = runnerTurnCount(receipt);
  return {
    providerSessionId: receipt.sessionId,
    outcome: { kind: "message", body: text },
    providerDiagnostics: {
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      ...(toolUsage === undefined || toolUsage.length === 0 ? {} : { toolUsage }),
      ...(turnCount === 0 ? {} : { turnCount })
    }
  };
}

const piPolicyHelperSource = [
  piArgs.toString(),
  piOptions.toString(),
  validatedChatReadToolGrant.toString(),
  rejectPiResourceLaunchArgs.toString(),
  piWorkspaceAccess.toString()
].join("\n");

function piPolicyResources(
  chatReadToolNames: readonly string[] = [],
  chatReadToolManifestDigest = ""
):
Readonly<Record<string, string>> {
  return {
    piReadonlyGitExtensionPath: piReadonlyGitExtension,
    piReadonlyGitExtensionSource: readFileSync(piReadonlyGitExtension, "utf8"),
    piChatHistoryExtensionPath: piChatHistoryExtension,
    piChatHistoryExtensionSource: readFileSync(piChatHistoryExtension, "utf8"),
    piChatReadToolNames: chatReadToolNames.join(","),
    piChatReadToolManifestDigest: chatReadToolManifestDigest
  };
}

function validatedChatReadToolGrant(
  grant: PiRuntimeAgentOptions["chatReadToolGrant"]
): { readonly tools: readonly string[]; readonly manifestDigest: string } {
  if (grant === undefined) return { tools: [], manifestDigest: "" };
  const tools = [...grant.tools];
  if (!/^[a-f0-9]{64}$/u.test(grant.manifestDigest) ||
    tools.length === 0 || new Set(tools).size !== tools.length ||
    tools.some((name) => !/^[a-z][a-z0-9_]{1,63}$/u.test(name))) {
    throw new Error("Pi Chat read tool grant is malformed");
  }
  return { tools, manifestDigest: grant.manifestDigest };
}

function piTokenUsage(usage: RunnerUsage | undefined) {
  if (usage === undefined) return undefined;
  const inputTokens = finiteNonNegative(usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.outputTokens);
  const cacheReadTokens = finiteNonNegative(usage.cacheReadTokens);
  const cacheCreationTokens = finiteNonNegative(usage.cacheCreationTokens);
  const costUsd = finiteNonNegative(usage.costUsd);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd]
    .every((token) => token === undefined)) {
    return undefined;
  }
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
