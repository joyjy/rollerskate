import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import type { RuntimeAgentAdapter } from "../../core/runtime/handlers.js";
import { runtimeAgentEventPrompt } from "./event-prompt.js";
import {
  BoundedToolUsage,
  finiteNonNegative,
  invocationDiagnostics,
  type ProviderInvocationDiagnostics
} from "./invocation-diagnostics.js";
import { providerPolicyObservationFromArgv } from "./provider-policy.js";
import { PiRpcRunner } from "./runner/pi-rpc.js";
import {
  runnerAssistantMessages,
  runnerToolNames,
  runnerTurnCount,
  runnerUsage,
  type RunnerTurnReceipt,
  type RunnerUsage
} from "./runner/protocol.js";

interface PiRequest {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId: string;
  readonly chatHistoryContext?: PiChatHistoryContext;
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
  readonly maxOutputBytes?: number;
  readonly launchArgs?: readonly string[];
  readonly resolveChatHistoryContext?: (
    input: Pick<PiRequest, "event" | "providerSessionId">
  ) => PiChatHistoryContext | undefined;
}

export interface PiChatHistoryContext {
  readonly runtimeDirectory: string;
  readonly topicId: string;
  readonly sourceMessageEventId: string;
}

export const PI_CHAT_HISTORY_CONTEXT_ENV = "ROLLERSKATE_CHAT_HISTORY_CONTEXT";

const piChatHistoryExtension = fileURLToPath(new URL(
  "../../../resources/agents/pi-chat-history.mjs",
  import.meta.url
));

export class PiRuntimeAgent implements RuntimeAgentAdapter {
  public readonly adapterId = "pi-runtime-rpc-v1";
  public readonly providerPolicy;
  public readonly workspace: string;
  readonly #launchArgs: readonly string[];
  readonly #processOptions: Omit<PiRuntimeAgentOptions, "resolveChatHistoryContext">;
  readonly #resolveChatHistoryContext: PiRuntimeAgentOptions["resolveChatHistoryContext"];

  public constructor(options: PiRuntimeAgentOptions) {
    this.workspace = workspace(options.projectRoot);
    this.#launchArgs = [...(options.launchArgs ?? [])];
    this.#resolveChatHistoryContext = options.resolveChatHistoryContext;
    this.providerPolicy = providerPolicyObservationFromArgv(
      "pi",
      piOptions(undefined, this.#launchArgs),
      piPolicyHelperSource
    );
    this.#processOptions = options;
  }

  public async invoke(input: Parameters<RuntimeAgentAdapter["invoke"]>[0]):
  Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    const resolutionInput: PiRequest = {
      event: input.event,
      providerSessionId: input.providerSessionId ?? randomUUID()
    };
    const chatHistoryContext = this.#resolveChatHistoryContext?.(resolutionInput);
    const request = {
      ...resolutionInput,
      ...(chatHistoryContext === undefined
        ? {}
        : { chatHistoryContext })
    } satisfies PiRequest;
    const access = piWorkspaceAccess(request.event);
    providerPolicyObservationFromArgv(
      "pi",
      piArgs(request, this.#launchArgs),
      piPolicyHelperSource,
      {},
      access
    );
    const process = new PiRpcRunner({
      adapterId: this.adapterId,
      executable: this.#processOptions.executable,
      args: piArgs(request, this.#launchArgs),
      environment: {
        ...this.#processOptions.environment,
        ...(request.chatHistoryContext === undefined
          ? {}
          : { [PI_CHAT_HISTORY_CONTEXT_ENV]: JSON.stringify(request.chatHistoryContext) })
      },
      workingDirectory: this.workspace,
      timeoutMilliseconds: this.#processOptions.timeoutMilliseconds,
      maxOutputBytes: this.#processOptions.maxOutputBytes ?? 1_048_576
    });
    const result = await process.invoke({
      prompt: runtimeAgentEventPrompt(request.event),
      sessionId: request.providerSessionId,
      workspaceAccess: access
    });
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
  launchArgs: readonly string[]
): string[] {
  const access = piWorkspaceAccess(request.event);
  return [
    ...piOptions(
      access,
      launchArgs,
      request.chatHistoryContext !== undefined
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
  chatHistory: boolean = false
): string[] {
  return [
    ...launchArgs,
    "--mode", "rpc",
    ...(chatHistory ? ["--extension", piChatHistoryExtension] : []),
    "--tools", access === "write"
      ? `read,write,edit,bash,grep,find,ls${chatHistory ? ",read_chat_history" : ""}`
      : `read,grep,find,ls${chatHistory ? ",read_chat_history" : ""}`
  ];
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
  piWorkspaceAccess.toString()
].join("\n");

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
