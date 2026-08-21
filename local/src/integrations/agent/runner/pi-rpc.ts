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
  RunnerUsage
} from "./protocol.js";

export interface PiRpcRunnerOptions {
  readonly adapterId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
}

export class PiRpcRunner implements AgentRunner {
  readonly #options: PiRpcRunnerOptions;

  public constructor(options: PiRpcRunnerOptions) {
    this.#options = options;
  }

  public invoke(request: RunnerTurnRequest): Promise<RunnerTurnReceipt> {
    if (request.sessionId === undefined || request.sessionId.trim() === "") {
      return Promise.reject(new Error("pi RPC requires a Session id"));
    }
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const child = spawnRunnerProcess({
        executable: this.#options.executable,
        args: this.#options.args,
        workingDirectory: this.#options.workingDirectory,
        environment: this.#options.environment
      });
      const stderr = collectBoundedStderr(child);
      const events: RunnerEvent[] = [];
      let settled = false;
      let stateSessionId: string | undefined;
      let promptAccepted = false;
      let assistantBytes = 0;
      let assistantMessageSeen = false;
      let toolEventsComplete = true;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void (async () => {
          if (error !== undefined) {
            await stopRunnerProcess(child);
            reject(withStderr(error, stderr()));
            return;
          }
          await stopRunnerProcess(child);
          if (stateSessionId === undefined) {
            reject(new Error("pi RPC response is missing Session state"));
            return;
          }
          if (stateSessionId !== request.sessionId) {
            reject(new Error("pi RPC response Session id does not match the request"));
            return;
          }
          if (!promptAccepted) {
            reject(new Error("pi RPC prompt was not accepted"));
            return;
          }
          resolve({
            startedAt,
            completedAt: new Date().toISOString(),
            sessionId: stateSessionId,
            toolEventsComplete,
            events
          });
        })();
      };

      const decoder = new JsonLineResponseDecoder({
        maxLineBytes: this.#options.maxOutputBytes,
        onDiscardedLine: () => {
          toolEventsComplete = false;
        },
        onMessage: (value): boolean => {
          if (!isRecord(value)) return false;
          if (value.type === "response" && value.command === "get_state") {
            if (value.success !== true) {
              finish(new Error(`pi RPC get_state failed: ${responseError(value)}`));
              return true;
            }
            if (isRecord(value.data) && typeof value.data.sessionId === "string") {
              stateSessionId = value.data.sessionId;
            }
          }
          if (value.type === "response" && value.command === "prompt") {
            if (value.success !== true) {
              finish(new Error(`pi RPC prompt failed: ${responseError(value)}`));
              return true;
            }
            promptAccepted = true;
          }
          const includeAgentEnd = value.type !== "agent_end" || !assistantMessageSeen;
          for (const event of piRunnerEvents(value, includeAgentEnd)) {
            if (event.type === "assistant.message") {
              assistantMessageSeen = true;
              assistantBytes += Buffer.byteLength(event.message.text, "utf8");
              if (assistantBytes > this.#options.maxOutputBytes) {
                finish(new Error(
                  `pi Runtime assistant output exceeds ${this.#options.maxOutputBytes} bytes`
                ));
                return true;
              }
            }
            events.push(event);
          }
          if (value.type === "agent_settled") finish();
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
          finish(new Error(`pi RPC response decoding failed: ${errorMessage(error)}`));
        }
      });
      child.once("error", (error) => finish(error));
      child.stdin.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (settled) return;
        const detail = stderr();
        finish(new Error(
          `pi RPC process exited before agent settlement ` +
          `(code=${String(code)} signal=${String(signal)}): ` +
          (detail === "" ? "no process diagnostics" : detail)
        ));
      });
      child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
      child.stdin.write(`${JSON.stringify({
        id: "prompt",
        type: "prompt",
        message: request.prompt
      })}\n`);
    });
  }
}

function piRunnerEvents(
  value: Readonly<Record<string, unknown>>,
  includeAgentEnd: boolean
): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  if (value.type === "message_end") addAssistantEvent(events, value.message);
  if (includeAgentEnd && value.type === "agent_end" && Array.isArray(value.messages)) {
    addAssistantEvent(events, value.messages.findLast(isAssistantMessage));
  }
  if (value.type === "tool_execution_end" && typeof value.toolName === "string") {
    events.push({ type: "tool.observed", tool: { name: value.toolName } });
  }
  if (value.type === "turn_end") events.push({ type: "turn.completed" });
  return events;
}

function addAssistantEvent(events: RunnerEvent[], message: unknown): void {
  const text = assistantText(message);
  if (text === undefined) return;
  events.push({ type: "assistant.message", message: { text } });
  const usage = piUsage(message);
  if (usage !== undefined) events.push({ type: "usage.updated", usage });
}

function isAssistantMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "assistant";
}

function assistantText(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  return message.content
    .filter((block) => isRecord(block) && block.type === "text" &&
      typeof block.text === "string")
    .map((block) => (block as { readonly text: string }).text)
    .join("");
}

function piUsage(message: unknown): RunnerUsage | undefined {
  if (!isRecord(message) || !isRecord(message.usage)) return undefined;
  const inputTokens = finiteNonNegative(message.usage.input);
  const outputTokens = finiteNonNegative(message.usage.output);
  const cacheReadTokens = finiteNonNegative(message.usage.cacheRead);
  const cacheCreationTokens = finiteNonNegative(message.usage.cacheWrite);
  const costUsd = isRecord(message.usage.cost)
    ? finiteNonNegative(message.usage.cost.total)
    : undefined;
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

function responseError(response: Readonly<Record<string, unknown>>): string {
  return typeof response.error === "string" ? response.error : "unknown RPC error";
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
