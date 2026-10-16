import { JsonLineResponseDecoder } from "../json-line-decoder.js";
import { finiteNonNegative } from "../invocation-diagnostics.js";
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

// Wire records can contain tool results or turn snapshots, independently of the
// assistant text budget. This is a transport bound, not a model context budget.
const MAX_PROTOCOL_RECORD_BYTES = 16 * 1_048_576;

export interface CodexAppServerRunnerOptions {
  readonly adapterId: string;
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly meaningfulOutputTimeoutMilliseconds: number;
  readonly maxOutputBytes: number;
  readonly threadParameters: Readonly<Record<string, unknown>>;
  readonly turnSandboxPolicy?: Readonly<Record<string, unknown>>;
}

export class CodexAppServerRunner implements AgentRunner {
  readonly #options: CodexAppServerRunnerOptions;

  public constructor(options: CodexAppServerRunnerOptions) {
    this.#options = options;
  }

  public invoke(request: RunnerTurnRequest): Promise<RunnerTurnReceipt> {
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
    return new Promise((resolve, reject) => {
      const child = spawnRunnerProcess({
        executable: this.#options.executable,
        args: ["app-server", "--stdio"],
        workingDirectory: this.#options.workingDirectory,
        environment: this.#options.environment
      });
      const stderr = collectBoundedStderr(child);
      const assistantMessages = new Map<string, string>();
      const toolEvents: RunnerEvent[] = [];
      let usageEvent: RunnerEvent | undefined;
      let assistantBytes = 0;
      let settled = false;
      let threadId: string | undefined;
      let turnId: string | undefined;
      let totalTimeout: NodeJS.Timeout | undefined;
      let meaningfulTimeout: NodeJS.Timeout | undefined;
      let interruptFlush: Promise<void> | undefined;

      const send = (message: Readonly<Record<string, unknown>>) => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (totalTimeout !== undefined) clearTimeout(totalTimeout);
        if (meaningfulTimeout !== undefined) clearTimeout(meaningfulTimeout);
        if (error === undefined) progress.phase("terminated");
        void (async () => {
          if (interruptFlush !== undefined) {
            await Promise.race([
              interruptFlush,
              new Promise<void>((flush) => setTimeout(flush, 100))
            ]);
          }
          await stopRunnerProcess(child, { closeStdin: true, graceMilliseconds: 5_000 });
          if (error !== undefined) {
            reject(withStderr(error, stderr()));
            return;
          }
          if (threadId === undefined) {
            reject(new Error("Codex app-server response is missing Thread id"));
            return;
          }
          const messages: RunnerEvent[] = [...assistantMessages.entries()]
            .filter(([, text]) => text !== "")
            .map(([, text]) => ({
              type: "assistant.message" as const,
              message: { text }
            }));
          resolve({
            startedAt,
            completedAt: new Date().toISOString(),
            sessionId: threadId,
            toolEventsComplete: true,
            events: [
              ...messages,
              ...toolEvents,
              ...(usageEvent === undefined ? [] : [usageEvent]),
              { type: "turn.completed" }
            ]
          });
        })();
      };
      let protocolComplete = true;
      const terminate = (reason: RunnerTerminationReason, message: string, rejectedBeforeWork = false) => {
        if (settled) return;
        progress.phase(reason === "protocol_exit" ? "terminated" : "cancelling");
        const protocolStop = reason === "protocol_exit" || threadId === undefined ||
          turnId === undefined || child.stdin.destroyed
          ? "unavailable" as const
          : "requested" as const;
        if (protocolStop === "requested") {
          interruptFlush = new Promise((flushed) => {
            try {
              child.stdin.write(`${JSON.stringify({
                id: 3,
                method: "turn/interrupt",
                params: { threadId, turnId }
              })}\n`, () => flushed());
            } catch {
              flushed();
            }
          });
        }
        finish(runnerInvocationFailure({
          message,
          rejectedBeforeWork: rejectedBeforeWork && protocolComplete,
          progress,
          reason,
          totalTimeoutMilliseconds,
          meaningfulOutputTimeoutMilliseconds,
          protocolStop
        }));
      };
      const finishTerminalFailure = (
        reason: "cancelled" | "protocol_error",
        message: string,
        protocolStop: "acknowledged" | "unavailable",
        rejectedBeforeWork = false
      ) => {
        progress.phase("terminated");
        finish(runnerInvocationFailure({
          message,
          rejectedBeforeWork: rejectedBeforeWork && protocolComplete,
          progress,
          reason,
          totalTimeoutMilliseconds,
          meaningfulOutputTimeoutMilliseconds,
          protocolStop
        }));
      };
      const resetMeaningfulTimeout = () => {
        if (settled) return;
        if (meaningfulTimeout !== undefined) clearTimeout(meaningfulTimeout);
        meaningfulTimeout = setTimeout(() => {
          terminate(
            "stall",
            `agent invocation stalled without meaningful output: ${this.#options.adapterId}`
          );
        }, meaningfulOutputTimeoutMilliseconds);
      };
      const addAssistantText = (itemId: string, text: string, replace: boolean) => {
        const previous = replace ? "" : (assistantMessages.get(itemId) ?? "");
        const next = `${previous}${text}`;
        assistantBytes += Buffer.byteLength(next, "utf8") -
          Buffer.byteLength(assistantMessages.get(itemId) ?? "", "utf8");
        if (assistantBytes > this.#options.maxOutputBytes) {
          terminate("protocol_error",
            `Codex assistant output exceeds ${this.#options.maxOutputBytes} bytes`
          );
          return;
        }
        assistantMessages.set(itemId, next);
      };

      const decoder = new JsonLineResponseDecoder({
        maxLineBytes: MAX_PROTOCOL_RECORD_BYTES,
        onDiscardedLine: () => {
          protocolComplete = false;
          terminate("protocol_error",
            `Codex app-server protocol record exceeds ${MAX_PROTOCOL_RECORD_BYTES} bytes`
          );
        },
        onMessage: (value): boolean => {
          if (!isRecord(value)) return false;
          if (value.id !== undefined && typeof value.method === "string") {
            terminate(
              "protocol_error",
              `Codex app-server unexpectedly requested ${value.method}`
            );
            return true;
          }
          if (value.id === 0) {
            if (value.error !== undefined) {
              terminate(
                "protocol_error",
                `Codex initialize failed: ${rpcError(value.error)}`, true
              );
              return true;
            }
            send({ method: "initialized" });
            send({
              id: 1,
              method: request.sessionId === undefined ? "thread/start" : "thread/resume",
              params: {
                ...this.#options.threadParameters,
                ...(request.sessionId === undefined ? {} : {
                  threadId: request.sessionId,
                  // Restore the model's context without returning its full transcript
                  // to this client, which consumes only the new turn's events.
                  excludeTurns: true
                })
              }
            });
            return true;
          }
          if (value.id === 1) {
            if (value.error !== undefined) {
              terminate(
                "protocol_error",
                `Codex Thread setup failed: ${rpcError(value.error)}`, true
              );
              return true;
            }
            const result = value.result;
            if (!isRecord(result) || !isRecord(result.thread) ||
              typeof result.thread.id !== "string") {
              terminate(
                "protocol_error",
                "Codex Thread setup response is missing Thread id"
              );
              return true;
            }
            if (request.sessionId !== undefined && result.thread.id !== request.sessionId) {
              terminate(
                "protocol_error",
                "Codex resumed Thread id does not match the request"
              );
              return true;
            }
            threadId = result.thread.id;
            progress.session(threadId);
            send({
              id: 2,
              method: "turn/start",
              params: {
                threadId,
                ...(this.#options.turnSandboxPolicy === undefined ? {} : {sandboxPolicy: this.#options.turnSandboxPolicy}),
                input: [{ type: "text", text: request.prompt }]
              }
            });
            progress.phase("prompting");
            return true;
          }
          if (value.id === 2) {
            if (value.error !== undefined) {
              terminate(
                "protocol_error",
                `Codex turn start failed: ${rpcError(value.error)}`, true
              );
              return true;
            }
            if (!isRecord(value.result) || !isRecord(value.result.turn) ||
              typeof value.result.turn.id !== "string") {
              terminate(
                "protocol_error",
                "Codex turn start response is missing Turn id"
              );
              return true;
            }
            if (turnId !== undefined && value.result.turn.id !== turnId) {
              terminate("protocol_error", "Codex app-server changed the active Turn id");
              return true;
            }
            turnId = value.result.turn.id;
          }
          if (value.method === "turn/started" && isRecord(value.params) &&
            isRecord(value.params.turn) && typeof value.params.turn.id === "string" &&
            threadId !== undefined && value.params.threadId === threadId) {
            if (turnId !== undefined && value.params.turn.id !== turnId) {
              terminate("protocol_error", "Codex app-server changed the active Turn id");
              return true;
            }
            turnId = value.params.turn.id;
          }
          const progressEvent = codexProgress(value, threadId, turnId);
          if (progressEvent !== undefined) {
            progress.observe(progressEvent.kind, progressEvent.meaningful);
            if (progressEvent.kind === "thought") request.onOutput?.({kind: "thought"});
            else if (progressEvent.kind === "tool" && isRecord(value.params)) {
              request.onOutput?.({kind: value.method === "item/started" ? "tool.call" : value.method === "item/completed" ? "tool.result" : "tool.update", data: value.params});
            }
            if (progressEvent.meaningful) resetMeaningfulTimeout();
          }
          if (value.method === "item/agentMessage/delta" && isRecord(value.params) &&
            matchesActiveTurn(value.params, threadId, turnId) &&
            typeof value.params.itemId === "string" && typeof value.params.delta === "string") {
            request.onOutput?.({kind: "assistant.delta", data: {itemId: value.params.itemId, text: value.params.delta}});
            addAssistantText(value.params.itemId, value.params.delta, false);
          }
          if (value.method === "item/completed" && isRecord(value.params) &&
            matchesActiveTurn(value.params, threadId, turnId) &&
            isRecord(value.params.item)) {
            const item = value.params.item;
            if (item.type === "agentMessage" && typeof item.id === "string" &&
              typeof item.text === "string") {
              request.onOutput?.({kind: "assistant.message", data: {itemId: item.id, text: item.text}});
              addAssistantText(item.id, item.text, true);
            } else if (typeof item.type === "string" &&
              !["reasoning", "userMessage", "plan"].includes(item.type)) {
              toolEvents.push({
                type: "tool.observed",
                tool: {
                  name: codexToolName(item)
                }
              });
            }
          }
          if (value.method === "thread/tokenUsage/updated" && isRecord(value.params) &&
            matchesActiveTurn(value.params, threadId, turnId) &&
            isRecord(value.params.tokenUsage) && isRecord(value.params.tokenUsage.last)) {
            const last = value.params.tokenUsage.last;
            usageEvent = {
              type: "usage.updated",
              usage: {
                ...numberProperty(last.inputTokens, "inputTokens"),
                ...numberProperty(last.outputTokens, "outputTokens"),
                ...numberProperty(last.cachedInputTokens, "cacheReadTokens"),
                ...numberProperty(last.totalTokens, "totalTokens")
              }
            };
          }
          if (value.method === "turn/completed" && isRecord(value.params) &&
            matchesActiveThread(value.params, threadId) && isRecord(value.params.turn) &&
            (turnId === undefined || value.params.turn.id === turnId)) {
            const status = value.params.turn.status;
            if (status === "completed") {
              finish();
            } else if (status === "interrupted") {
              finishTerminalFailure(
                "cancelled",
                "Codex turn ended with interrupted",
                "acknowledged"
              );
            } else {
              const detail = isRecord(value.params.turn.error) &&
                typeof value.params.turn.error.message === "string"
                ? `: ${value.params.turn.error.message}`
                : "";
              finishTerminalFailure(
                "protocol_error",
                `Codex turn ended with ${String(status)}${detail}`,
                "unavailable",
                status === "failed"
              );
            }
          }
          return true;
        },
        complete: () => undefined
      });

      resetMeaningfulTimeout();
      if (totalTimeoutMilliseconds !== undefined) {
        totalTimeout = setTimeout(() => {
          terminate("deadline", `agent invocation timed out: ${this.#options.adapterId}`);
        }, totalTimeoutMilliseconds);
      }
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        try {
          decoder.push(chunk);
        } catch (error) {
          terminate(
            "protocol_error",
            `Codex app-server decoding failed: ${errorMessage(error)}`
          );
        }
      });
      child.once("error", (error) => terminate("protocol_exit", errorMessage(error)));
      child.stdin.once("error", (error) => terminate("protocol_exit", errorMessage(error)));
      child.once("close", (code, signal) => {
        if (settled) return;
        terminate("protocol_exit",
          `Codex app-server exited before turn completion ` +
          `(code=${String(code)} signal=${String(signal)})`
        );
      });
      send({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "rollerskate-local", version: "0.6.0" },
          capabilities: {}
        }
      });
    });
  }
}

function codexProgress(
  value: Readonly<Record<string, unknown>>,
  threadId: string | undefined,
  turnId: string | undefined
): {
  readonly kind: "assistant" | "thought" | "tool" | "plan" | "protocol";
  readonly meaningful: boolean;
} | undefined {
  if (typeof value.method !== "string" || !isRecord(value.params) ||
    !matchesActiveThread(value.params, threadId)) return undefined;
  if (typeof value.params.turnId === "string" && turnId !== undefined &&
    value.params.turnId !== turnId) return undefined;
  if ((value.method.startsWith("item/") || value.method.startsWith("hook/") || [
    "turn/diff/updated",
    "turn/plan/updated",
    "thread/tokenUsage/updated"
  ].includes(value.method)) && !matchesActiveTurn(value.params, threadId, turnId)) {
    return undefined;
  }
  if (value.method === "item/agentMessage/delta") {
    return { kind: "assistant", meaningful: true };
  }
  if ([
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ].includes(value.method)) {
    return { kind: "thought", meaningful: true };
  }
  if (value.method === "item/plan/delta" || value.method === "turn/plan/updated") {
    return { kind: "plan", meaningful: true };
  }
  if ([
    "hook/started",
    "hook/completed",
    "turn/diff/updated",
    "item/commandExecution/outputDelta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/mcpToolCall/progress"
  ].includes(value.method)) {
    return { kind: "tool", meaningful: true };
  }
  if ((value.method === "item/started" || value.method === "item/completed") &&
    isRecord(value.params.item)) {
    if (value.params.item.type === "agentMessage") {
      return { kind: "assistant", meaningful: true };
    }
    if (value.params.item.type === "reasoning") {
      return { kind: "thought", meaningful: true };
    }
    if (value.params.item.type === "plan") {
      return { kind: "plan", meaningful: true };
    }
    if (isCodexToolItem(value.params.item)) {
      return { kind: "tool", meaningful: true };
    }
  }
  return { kind: "protocol", meaningful: false };
}

function matchesActiveThread(
  params: Readonly<Record<string, unknown>>,
  threadId: string | undefined
): boolean {
  return threadId !== undefined && params.threadId === threadId;
}

function matchesActiveTurn(
  params: Readonly<Record<string, unknown>>,
  threadId: string | undefined,
  turnId: string | undefined
): boolean {
  return matchesActiveThread(params, threadId) && turnId !== undefined &&
    params.turnId === turnId;
}

function codexToolName(item: Readonly<Record<string, unknown>>): string {
  if (item.type === "mcpToolCall" && typeof item.tool === "string") {
    return typeof item.server === "string" ? `${item.server}/${item.tool}` : item.tool;
  }
  if (typeof item.name === "string") return item.name;
  return String(item.type);
}

function isCodexToolItem(item: Readonly<Record<string, unknown>>): boolean {
  return typeof item.type === "string" &&
    !["agentMessage", "reasoning", "userMessage", "plan"].includes(item.type);
}

function numberProperty(value: unknown, key: string): Readonly<Record<string, number>> {
  const number = finiteNonNegative(value);
  return number === undefined ? {} : { [key]: number };
}

function rpcError(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function withStderr(error: Error, stderr: string): Error {
  const message = `${error.message}${stderr === "" ? "" : `\nstderr: ${stderr}`}`;
  return error instanceof RunnerInvocationError
    ? new RunnerInvocationError(message, error.trace)
    : new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
