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
import {
  AcpRunner,
  kimiMode,
  kimiPermissionDecision
} from "./runner/acp.js";
import {
  runnerAssistantMessages,
  runnerToolNames,
  runnerTurnCount,
  runnerUsage,
  RunnerInvocationError,
  type RunnerTurnReceipt,
  type RunnerUsage
} from "./runner/protocol.js";
import {
  kimiProviderSessionId,
  kimiSessionReference,
  kimiSessionReferenceVersion
} from "./kimi-session-reference.js";
import { providerPolicyObservationFromArgv } from "./provider-policy.js";

const kimiReadOnlyAgentFile = fileURLToPath(new URL(
  "../../../resources/agents/kimi-readonly-chat.md",
  import.meta.url
));
const kimiWritableAgentFile = fileURLToPath(new URL(
  "../../../resources/agents/kimi-writable-workspace.md",
  import.meta.url
));

export interface KimiCodeRuntimeAgentOptions {
  readonly executable: string;
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly meaningfulOutputTimeoutMilliseconds?: number;
  readonly maxOutputBytes?: number;
  readonly launchArgs?: readonly string[];
}

export class KimiCodeRuntimeAgent implements RuntimeAgentAdapter {
  public readonly adapterId: string;
  public readonly providerPolicy;
  public readonly workspace: string;
  readonly #client: AcpRunner;
  readonly #model: string | undefined;
  readonly #resources: Readonly<Record<string, string>>;

  public constructor(options: KimiCodeRuntimeAgentOptions) {
    this.workspace = workspace(options.projectRoot);
    this.#resources = {
      kimiReadOnlyAgent: readFileSync(kimiReadOnlyAgentFile, "utf8"),
      kimiWritableAgent: readFileSync(kimiWritableAgentFile, "utf8")
    };
    this.#model = kimiModel(options.launchArgs ?? []);
    this.providerPolicy = providerPolicyObservationFromArgv(
      "kimi-code",
      ["acp"],
      kimiPolicyHelperSource,
      this.#resources
    );
    this.adapterId = `kimi-code-runtime-acp-v1:${this.providerPolicy.hook.helperDigest}`;
    this.#client = new AcpRunner({
      adapterId: this.adapterId,
      executable: options.executable,
      environment: kimiEnvironment(options.environment),
      workingDirectory: this.workspace,
      maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
      meaningfulOutputTimeoutMilliseconds:
        options.meaningfulOutputTimeoutMilliseconds ??
        options.timeoutMilliseconds
    });
  }

  public async invoke(input: Parameters<RuntimeAgentAdapter["invoke"]>[0]):
  Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    const access = kimiWorkspaceAccess(input.event);
    const totalTimeoutMilliseconds = invocationTimeoutMilliseconds(input.event);
    const providerSessionId = kimiProviderSessionId(input.providerSessionId, access);
    providerPolicyObservationFromArgv(
      "kimi-code",
      ["acp"],
      kimiPolicyHelperSource,
      this.#resources,
      access
    );
    let result: RunnerTurnReceipt;
    try {
      result = await this.#client.invoke({
        ...(input.reportOutput === undefined ? {} : {onOutput: input.reportOutput}),
        prompt: kimiPrompt(
          access === "write"
            ? this.#resources.kimiWritableAgent!
            : this.#resources.kimiReadOnlyAgent!,
          input.event
        ),
        workspaceAccess: access,
        totalTimeoutMilliseconds,
        meaningfulOutputTimeoutMilliseconds:
          this.#client.defaultMeaningfulOutputTimeoutMilliseconds,
        ...(providerSessionId === undefined ? {} : { sessionId: providerSessionId }),
        ...(this.#model === undefined ? {} : { model: this.#model }),
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
                  : { providerSessionId: kimiSessionReference(access, progress.sessionId) })
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
          : { providerSessionId: kimiSessionReference(access, error.trace.sessionId) })
      }));
    }
    const response = kimiResponse(result, input.event.type === "chat.dispatch");
    return {
      providerSessionId: kimiSessionReference(access, response.providerSessionId),
      outcome: response.outcome,
      invocation: invocationDiagnostics(input.event, result, response.providerDiagnostics)
    };
  }
}

function kimiResponse(
  response: RunnerTurnReceipt,
  chat: boolean
): {
  readonly providerSessionId: string;
  readonly outcome: { readonly kind: "message"; readonly body: string };
  readonly providerDiagnostics: ProviderInvocationDiagnostics;
} {
  const messages = runnerAssistantMessages(response).map((message) => message.text);
  const tools = new BoundedToolUsage();
  for (const name of runnerToolNames(response)) tools.record(name);
  const text = chat ? messages.join("\n") : messages.at(-1);
  if (text === undefined || text.trim() === "") {
    throw new Error("Kimi Code ACP response is missing assistant output");
  }
  const tokenUsage = kimiTokenUsage(runnerUsage(response));
  const toolUsage = tools.result();
  return {
    providerSessionId: response.sessionId,
    outcome: { kind: "message", body: text },
    providerDiagnostics: {
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      ...(toolUsage === undefined || toolUsage.length === 0 ? {} : { toolUsage }),
      turnCount: runnerTurnCount(response)
    }
  };
}

function kimiTokenUsage(usage: RunnerUsage | undefined) {
  if (usage === undefined) return undefined;
  const inputTokens = finiteNonNegative(usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.outputTokens);
  const totalTokens = finiteNonNegative(usage.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens })
  };
}

function kimiPrompt(
  resource: string,
  event: AgentInputEvent | ChatDispatchEvent
): string {
  const policy = resource
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
    .replace(/^\s*\$\{base_prompt\}\s*/u, "")
    .trim();
  return `${policy}\n\n${runtimeAgentEventPrompt(event)}`;
}

function kimiModel(launchArgs: readonly string[]): string | undefined {
  if (launchArgs.length === 0) return undefined;
  if (launchArgs.length !== 2 || launchArgs[0] !== "--model" ||
    launchArgs[1] === undefined || launchArgs[1].trim() === "") {
    throw new Error("Kimi ACP launch args only support --model <model>");
  }
  return launchArgs[1];
}

function kimiEnvironment(
  environment: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return process.platform === "darwin"
    ? { ...environment, KIMI_CODE_LEGACY_FLAG: "1" }
    : environment;
}

function kimiWorkspaceAccess(
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

const kimiPolicyHelperSource = [
  kimiSessionReferenceVersion,
  kimiMode.toString(),
  kimiPermissionDecision.toString(),
  kimiPrompt.toString(),
  kimiModel.toString(),
  kimiEnvironment.toString(),
  kimiWorkspaceAccess.toString()
].join("\n");

function workspace(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
  const canonical = realpathSync(projectRoot);
  if (!statSync(canonical).isDirectory()) throw new Error("projectRoot must be a directory");
  return canonical;
}
