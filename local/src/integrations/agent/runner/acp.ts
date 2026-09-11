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
  RunnerTurnRequest,
  RunnerTerminationReason
} from "./protocol.js";
import {
  RunnerInvocationError,
  RunnerProgressTracker,
  runnerInvocationFailure,
  runnerMeaningfulTimeoutMilliseconds,
  runnerTimeoutMilliseconds
} from "./protocol.js";

export interface AcpRunnerOptions {
  readonly adapterId: string;
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly meaningfulOutputTimeoutMilliseconds: number;
  readonly maxOutputBytes: number;
}

export class AcpRunner implements AgentRunner {
  readonly #options: AcpRunnerOptions;

  public constructor(options: AcpRunnerOptions) {
    this.#options = options;
  }

  public get defaultMeaningfulOutputTimeoutMilliseconds(): number {
    return this.#options.meaningfulOutputTimeoutMilliseconds;
  }

  public async invoke(request: RunnerTurnRequest): Promise<RunnerTurnReceipt> {
    const startedAt = new Date().toISOString();
    const totalTimeoutMilliseconds = request.totalTimeoutMilliseconds === undefined
      ? undefined
      : runnerTimeoutMilliseconds(
          request.totalTimeoutMilliseconds,
          "totalTimeoutMilliseconds"
        );
    const meaningfulOutputTimeoutMilliseconds = runnerMeaningfulTimeoutMilliseconds(
      request.meaningfulOutputTimeoutMilliseconds ??
        this.#options.meaningfulOutputTimeoutMilliseconds
    );
    const progress = new RunnerProgressTracker(startedAt, request.onProgress);
    progress.phase("starting");
    const child = spawnRunnerProcess({
      executable: this.#options.executable,
      args: ["acp"],
      workingDirectory: this.#options.workingDirectory,
      environment: this.#options.environment
    });
    const stderr = collectBoundedStderr(child);
    let turnSettled = false;
    let meaningfulTimeout: NodeJS.Timeout | undefined;
    let rejectLifecycle: ((error: RunnerInvocationError) => void) | undefined;
    let terminationStarted = false;
    let activeContext: acp.ClientContext | undefined;
    let activeSessionId: string | undefined;
    let pendingCancelNotification: Promise<void> | undefined;
    const lifecycleFailure = new Promise<never>((_resolve, reject) => {
      rejectLifecycle = reject;
    });
    const terminate = (reason: RunnerTerminationReason, message: string) => {
      if (terminationStarted) return;
      terminationStarted = true;
      progress.phase(reason === "protocol_exit" ? "terminated" : "cancelling");
      const protocolStop = reason === "protocol_exit" ||
        activeContext === undefined || activeSessionId === undefined
        ? "unavailable" as const
        : "requested" as const;
      if (protocolStop === "requested") {
        pendingCancelNotification = Promise.resolve(activeContext!.notify(
          acp.methods.agent.session.cancel,
          {
            sessionId: activeSessionId!
          }
        )).catch(() => undefined);
      }
      rejectLifecycle?.(runnerInvocationFailure({
        message,
        progress,
        reason,
        totalTimeoutMilliseconds,
        meaningfulOutputTimeoutMilliseconds,
        protocolStop
      }));
    };
    child.once("error", (error) => {
      terminate("protocol_exit", errorMessage(error));
    });
    child.once("exit", (code, signal) => {
      if (turnSettled) return;
      terminate(
        "protocol_exit",
        `Kimi ACP process exited before turn settlement ` +
        `(code=${String(code)} signal=${String(signal)})`
      );
    });
    const resetMeaningfulTimeout = () => {
      if (terminationStarted) return;
      if (meaningfulTimeout !== undefined) clearTimeout(meaningfulTimeout);
      meaningfulTimeout = setTimeout(() => {
        terminate(
          "stall",
          `agent invocation stalled without meaningful output: ${this.#options.adapterId}`
        );
      }, meaningfulOutputTimeoutMilliseconds);
    };
    resetMeaningfulTimeout();

    let totalTimeout: NodeJS.Timeout | undefined;
    if (totalTimeoutMilliseconds !== undefined) {
      totalTimeout = setTimeout(() => {
        terminate("deadline", `agent invocation timed out: ${this.#options.adapterId}`);
      }, totalTimeoutMilliseconds);
    }
    const updates: acp.SessionUpdate[] = [];
    let assistantOutputBytes = 0;
    const application = acp
      .client({ name: "rollerskate-local" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        kimiPermissionDecision(request.workspaceAccess, params))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (terminationStarted || params.sessionId !== activeSessionId) return;
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text") {
          assistantOutputBytes += Buffer.byteLength(update.content.text, "utf8");
          if (assistantOutputBytes > this.#options.maxOutputBytes) {
            terminate(
              "protocol_error",
              `Kimi Code assistant output exceeds ${this.#options.maxOutputBytes} bytes`
            );
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
        const kind = progressKind(update);
        if (kind !== undefined) progress.observe(kind, isMeaningfulUpdate(update));
        if (isMeaningfulUpdate(update)) resetMeaningfulTimeout();
      });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    );

    try {
      const response = await Promise.race([
        application.connectWith(stream, async (context) => {
          activeContext = context;
          const initialized = await context.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "Rollerskate Local", version: "0.6.0" }
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
          progress.session(activeSessionId);
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
          progress.phase("prompting");
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
        lifecycleFailure
      ]);
      turnSettled = true;
      if (response.stopReason === "cancelled") {
        progress.phase("terminated");
        throw runnerInvocationFailure({
          message: `Kimi ACP turn stopped with ${response.stopReason}`,
          progress,
          reason: "cancelled",
          totalTimeoutMilliseconds,
          meaningfulOutputTimeoutMilliseconds,
          protocolStop: "acknowledged"
        });
      }
      if (response.stopReason !== "end_turn") {
        throw runnerInvocationFailure({
          message: `Kimi ACP turn stopped with ${response.stopReason}`,
          progress,
          reason: "protocol_error",
          totalTimeoutMilliseconds,
          meaningfulOutputTimeoutMilliseconds,
          protocolStop: "unavailable"
        });
      }
      progress.phase("terminated");
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        sessionId: response.sessionId,
        toolEventsComplete: true,
        events: acpRunnerEvents(response.updates, response.usage)
      };
    } catch (error) {
      const detail = stderr();
      if (error instanceof RunnerInvocationError) {
        throw new RunnerInvocationError(
          `${error.message}${detail === "" ? "" : `\nstderr: ${detail}`}`,
          error.trace
        );
      }
      const connectionClosed = isAcpConnectionClosed(error);
      if (connectionClosed) progress.phase("terminated");
      throw runnerInvocationFailure({
        message: `${errorMessage(error)}${detail === "" ? "" : `\nstderr: ${detail}`}`,
        progress,
        reason: connectionClosed ? "protocol_exit" : "protocol_error",
        totalTimeoutMilliseconds,
        meaningfulOutputTimeoutMilliseconds,
        protocolStop: "unavailable"
      });
    } finally {
      if (meaningfulTimeout !== undefined) clearTimeout(meaningfulTimeout);
      if (totalTimeout !== undefined) clearTimeout(totalTimeout);
      if (pendingCancelNotification !== undefined) {
        await Promise.race([
          pendingCancelNotification,
          new Promise<void>((resolve) => setTimeout(resolve, 100))
        ]);
      }
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

function progressKind(update: acp.SessionUpdate):
  "assistant" | "thought" | "tool" | "plan" | "protocol" | undefined {
  if (update.sessionUpdate === "agent_message_chunk") return "assistant";
  if (update.sessionUpdate === "agent_thought_chunk") return "thought";
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return "tool";
  }
  if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") return "plan";
  return "protocol";
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

function isAcpConnectionClosed(error: unknown): boolean {
  return error instanceof Error && error.message === "ACP connection closed";
}
