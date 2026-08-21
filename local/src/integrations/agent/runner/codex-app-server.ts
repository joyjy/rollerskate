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
  RunnerTurnRequest
} from "./protocol.js";

export interface CodexAppServerRunnerOptions {
  readonly adapterId: string;
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
  readonly threadParameters: Readonly<Record<string, unknown>>;
}

export class CodexAppServerRunner implements AgentRunner {
  readonly #options: CodexAppServerRunnerOptions;

  public constructor(options: CodexAppServerRunnerOptions) {
    this.#options = options;
  }

  public invoke(request: RunnerTurnRequest): Promise<RunnerTurnReceipt> {
    const startedAt = new Date().toISOString();
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

      const send = (message: Readonly<Record<string, unknown>>) => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void (async () => {
          await stopRunnerProcess(child, { closeStdin: true });
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
      const addAssistantText = (itemId: string, text: string, replace: boolean) => {
        const previous = replace ? "" : (assistantMessages.get(itemId) ?? "");
        const next = `${previous}${text}`;
        assistantBytes += Buffer.byteLength(next, "utf8") -
          Buffer.byteLength(assistantMessages.get(itemId) ?? "", "utf8");
        if (assistantBytes > this.#options.maxOutputBytes) {
          finish(new Error(
            `Codex assistant output exceeds ${this.#options.maxOutputBytes} bytes`
          ));
          return;
        }
        assistantMessages.set(itemId, next);
      };

      const decoder = new JsonLineResponseDecoder({
        maxLineBytes: this.#options.maxOutputBytes,
        onDiscardedLine: () => {
          finish(new Error(
            `Codex app-server record exceeds ${this.#options.maxOutputBytes} bytes`
          ));
        },
        onMessage: (value): boolean => {
          if (!isRecord(value)) return false;
          if (value.id !== undefined && typeof value.method === "string") {
            finish(new Error(`Codex app-server unexpectedly requested ${value.method}`));
            return true;
          }
          if (value.id === 0) {
            if (value.error !== undefined) {
              finish(new Error(`Codex initialize failed: ${rpcError(value.error)}`));
              return true;
            }
            send({ method: "initialized" });
            send({
              id: 1,
              method: request.sessionId === undefined ? "thread/start" : "thread/resume",
              params: {
                ...this.#options.threadParameters,
                ...(request.sessionId === undefined ? {} : { threadId: request.sessionId })
              }
            });
            return true;
          }
          if (value.id === 1) {
            if (value.error !== undefined) {
              finish(new Error(`Codex Thread setup failed: ${rpcError(value.error)}`));
              return true;
            }
            const result = value.result;
            if (!isRecord(result) || !isRecord(result.thread) ||
              typeof result.thread.id !== "string") {
              finish(new Error("Codex Thread setup response is missing Thread id"));
              return true;
            }
            threadId = result.thread.id;
            send({
              id: 2,
              method: "turn/start",
              params: {
                threadId,
                input: [{ type: "text", text: request.prompt }]
              }
            });
            return true;
          }
          if (value.id === 2 && value.error !== undefined) {
            finish(new Error(`Codex turn start failed: ${rpcError(value.error)}`));
            return true;
          }
          if (value.method === "item/agentMessage/delta" && isRecord(value.params) &&
            typeof value.params.itemId === "string" && typeof value.params.delta === "string") {
            addAssistantText(value.params.itemId, value.params.delta, false);
          }
          if (value.method === "item/completed" && isRecord(value.params) &&
            isRecord(value.params.item)) {
            const item = value.params.item;
            if (item.type === "agentMessage" && typeof item.id === "string" &&
              typeof item.text === "string") {
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
            isRecord(value.params.turn)) {
            if (value.params.turn.status !== "completed") {
              const detail = isRecord(value.params.turn.error) &&
                typeof value.params.turn.error.message === "string"
                ? `: ${value.params.turn.error.message}`
                : "";
              finish(new Error(
                `Codex turn ended with ${String(value.params.turn.status)}${detail}`
              ));
            } else {
              finish();
            }
          }
          return true;
        },
        complete: () => undefined
      });

      const timeout = setTimeout(() => {
        finish(new Error(`agent invocation timed out: ${this.#options.adapterId}`));
      }, this.#options.timeoutMilliseconds);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        try {
          decoder.push(chunk);
        } catch (error) {
          finish(new Error(`Codex app-server decoding failed: ${errorMessage(error)}`));
        }
      });
      child.once("error", (error) => finish(error));
      child.stdin.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (settled) return;
        finish(new Error(
          `Codex app-server exited before turn completion ` +
          `(code=${String(code)} signal=${String(signal)})`
        ));
      });
      send({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "rollerskate-local", version: "0.5.4" },
          capabilities: {}
        }
      });
    });
  }
}

function codexToolName(item: Readonly<Record<string, unknown>>): string {
  if (item.type === "mcpToolCall" && typeof item.tool === "string") {
    return typeof item.server === "string" ? `${item.server}/${item.tool}` : item.tool;
  }
  if (typeof item.name === "string") return item.name;
  return String(item.type);
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
  return new Error(`${error.message}${stderr === "" ? "" : `\nstderr: ${stderr}`}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
