import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import {
  collectBoundedStderr,
  spawnRunnerProcess,
  stopRunnerProcess
} from "./process.js";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerTurnReceipt,
  RunnerTurnRequest
} from "./protocol.js";

export interface AcpRunnerOptions {
  readonly adapterId: string;
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly timeoutMilliseconds: number;
  readonly meaningfulOutputTimeoutMilliseconds: number;
  readonly maxOutputBytes: number;
}

export class AcpRunner implements AgentRunner {
  readonly #options: AcpRunnerOptions;

  public constructor(options: AcpRunnerOptions) {
    this.#options = options;
  }

  public async invoke(request: RunnerTurnRequest): Promise<RunnerTurnReceipt> {
    const startedAt = new Date().toISOString();
    const child = spawnRunnerProcess({
      executable: this.#options.executable,
      args: ["acp"],
      workingDirectory: this.#options.workingDirectory,
      environment: this.#options.environment
    });
    const stderr = collectBoundedStderr(child);
    const processFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });

    let meaningfulTimeout: NodeJS.Timeout | undefined;
    let rejectMeaningfulTimeout: ((error: Error) => void) | undefined;
    const meaningfulFailure = new Promise<never>((_resolve, reject) => {
      rejectMeaningfulTimeout = reject;
    });
    const resetMeaningfulTimeout = () => {
      if (meaningfulTimeout !== undefined) clearTimeout(meaningfulTimeout);
      meaningfulTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectMeaningfulTimeout?.(new Error(
          `agent invocation stalled without meaningful output: ${this.#options.adapterId}`
        ));
      }, this.#options.meaningfulOutputTimeoutMilliseconds);
    };
    resetMeaningfulTimeout();

    let totalTimeout: NodeJS.Timeout | undefined;
    const totalFailure = new Promise<never>((_resolve, reject) => {
      totalTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`agent invocation timed out: ${this.#options.adapterId}`));
      }, this.#options.timeoutMilliseconds);
    });
    const updates: acp.SessionUpdate[] = [];
    let assistantOutputBytes = 0;
    let rejectResponse: ((error: Error) => void) | undefined;
    const responseFailure = new Promise<never>((_resolve, reject) => {
      rejectResponse = reject;
    });
    let activeSessionId: string | undefined;
    const application = acp
      .client({ name: "rollerskate-local" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        kimiPermissionDecision(request.workspaceAccess, params))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.sessionId !== activeSessionId) return;
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text") {
          assistantOutputBytes += Buffer.byteLength(update.content.text, "utf8");
          if (assistantOutputBytes > this.#options.maxOutputBytes) {
            child.kill("SIGKILL");
            rejectResponse?.(new Error(
              `Kimi Code assistant output exceeds ${this.#options.maxOutputBytes} bytes`
            ));
            return;
          }
          updates.push(update);
        } else if (update.sessionUpdate === "tool_call") {
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId: update.toolCallId,
            title: update.title,
            ...(update.name === undefined || update.name === null
              ? {}
              : { name: update.name })
          });
        }
        if (isMeaningfulUpdate(update)) resetMeaningfulTimeout();
      });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    );

    try {
      const response = await Promise.race([
        application.connectWith(stream, async (context) => {
          const initialized = await context.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "Rollerskate Local", version: "0.5.4" }
          });
          if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
            throw new Error(
              `Kimi ACP protocol version ${initialized.protocolVersion} is unsupported`
            );
          }
          let sessionState: KimiSessionState;
          if (request.sessionId !== undefined) {
            if (initialized.agentCapabilities?.sessionCapabilities?.resume === undefined ||
              initialized.agentCapabilities.sessionCapabilities.resume === null) {
              throw new Error("Kimi ACP does not support Session resume");
            }
            const resumed = await context.request(acp.methods.agent.session.resume, {
              sessionId: request.sessionId,
              cwd: this.#options.workingDirectory,
              mcpServers: []
            });
            sessionState = { sessionId: request.sessionId, ...resumed };
          } else {
            sessionState = await newKimiSession(context, this.#options.workingDirectory);
          }
          activeSessionId = sessionState.sessionId;
          const modeId = kimiMode(request.workspaceAccess);
          if (request.sessionId === undefined &&
            sessionState.modes?.currentModeId !== modeId) {
            await context.request(acp.methods.agent.session.setMode, {
              sessionId: activeSessionId,
              modeId
            });
          }
          if (request.model !== undefined &&
            !hasKimiConfigValue(sessionState.configOptions, "model", request.model)) {
            await context.request(acp.methods.agent.session.setConfigOption, {
              sessionId: activeSessionId,
              configId: "model",
              value: request.model
            });
          }
          const promptResponse = await context.request(acp.methods.agent.session.prompt, {
            sessionId: activeSessionId,
            prompt: [{ type: "text", text: request.prompt }]
          });
          return {
            sessionId: activeSessionId,
            stopReason: promptResponse.stopReason,
            updates,
            ...(promptResponse.usage === undefined || promptResponse.usage === null
              ? {}
              : { usage: promptResponse.usage })
          };
        }),
        meaningfulFailure,
        processFailure,
        responseFailure,
        totalFailure
      ]);
      if (response.stopReason !== "end_turn") {
        throw new Error(`Kimi ACP turn stopped with ${response.stopReason}`);
      }
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        sessionId: response.sessionId,
        toolEventsComplete: true,
        events: acpRunnerEvents(response.updates, response.usage)
      };
    } catch (error) {
      const detail = stderr();
      throw new Error(
        `${errorMessage(error)}${detail === "" ? "" : `\nstderr: ${detail}`}`
      );
    } finally {
      if (meaningfulTimeout !== undefined) clearTimeout(meaningfulTimeout);
      if (totalTimeout !== undefined) clearTimeout(totalTimeout);
      await stopRunnerProcess(child, { closeStdin: true, graceMilliseconds: 5_000 });
    }
  }
}

interface KimiSessionState {
  readonly sessionId: string;
  readonly modes?: acp.SessionModeState | null;
  readonly configOptions?: readonly acp.SessionConfigOption[] | null;
}

async function newKimiSession(
  context: acp.ClientContext,
  cwd: string
): Promise<KimiSessionState> {
  return context.request(acp.methods.agent.session.new, {
    cwd,
    mcpServers: []
  });
}

function hasKimiConfigValue(
  options: readonly acp.SessionConfigOption[] | null | undefined,
  id: string,
  value: string
): boolean {
  const option = options?.find((candidate) => candidate.id === id);
  return option?.type === "select" && option.currentValue === value;
}

export function kimiMode(access: "read" | "write"): string {
  return access === "read" ? "plan" : "default";
}

export function kimiPermissionDecision(
  access: "read" | "write",
  request: acp.RequestPermissionRequest
): acp.RequestPermissionResponse {
  const readOnlyKinds = new Set<acp.ToolKind>(["read", "search", "think", "fetch"]);
  const allowed = access === "write" ||
    (request.toolCall.kind !== undefined && request.toolCall.kind !== null &&
      readOnlyKinds.has(request.toolCall.kind));
  const kind = allowed ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: option.optionId } };
}

function isMeaningfulUpdate(update: acp.SessionUpdate): boolean {
  return [
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "plan_update"
  ].includes(update.sessionUpdate);
}

function acpRunnerEvents(
  updates: readonly acp.SessionUpdate[],
  usage: acp.Usage | undefined
): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  let messageId: string | null | undefined;
  let text = "";
  const flush = () => {
    if (text === "") return;
    events.push({
      type: "assistant.message",
      message: { text }
    });
    text = "";
  };
  for (const update of updates) {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      if (text !== "" && update.messageId !== messageId) flush();
      messageId = update.messageId;
      text += update.content.text;
    }
    if (update.sessionUpdate === "tool_call") {
      events.push({
        type: "tool.observed",
        tool: {
          name: typeof update.name === "string" ? update.name : update.title
        }
      });
    }
  }
  flush();
  if (usage !== undefined) {
    events.push({
      type: "usage.updated",
      usage: {
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens })
      }
    });
  }
  events.push({ type: "turn.completed" });
  return events;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
