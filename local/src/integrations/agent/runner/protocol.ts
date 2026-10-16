import type { AgentOutputEvent } from "../../../core/runtime/agent-invocation.js";
import { performance } from "node:perf_hooks";

export interface RunnerTurnRequest {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly workspaceAccess: "read" | "write";
  readonly model?: string;
  readonly totalTimeoutMilliseconds?: number | undefined;
  readonly meaningfulOutputTimeoutMilliseconds?: number;
  readonly onOutput?: (event: AgentOutputEvent) => void;
  readonly onProgress?: (progress: RunnerProgress) => void;
}

export type RunnerPhase =
  | "starting"
  | "session_ready"
  | "prompting"
  | "streaming"
  | "cancelling"
  | "terminated";

export type RunnerProgressKind =
  | "session"
  | "assistant"
  | "thought"
  | "tool"
  | "plan"
  | "protocol";

export interface RunnerProgress {
  readonly schemaVersion: "RunnerProgress@1";
  readonly startedAt: string;
  readonly observedAt: string;
  readonly lastMeaningfulAt: string;
  readonly sessionId?: string;
  readonly phase: RunnerPhase;
  readonly updateCount: number;
  readonly meaningfulUpdateCount: number;
  readonly lastProgress?: { readonly kind: RunnerProgressKind };
}

export type RunnerTerminationReason =
  | "stall"
  | "deadline"
  | "protocol_exit"
  | "cancelled"
  | "protocol_error";

export interface RunnerFailureTrace extends RunnerProgress {
  readonly rejectedBeforeWork?: true;
  readonly failedAt: string;
  readonly reason: RunnerTerminationReason;
  readonly totalTimeoutMilliseconds?: number | undefined;
  readonly meaningfulOutputTimeoutMilliseconds: number;
  readonly protocolStop: "requested" | "acknowledged" | "unavailable";
}

export class RunnerInvocationError extends Error {
  public readonly trace: RunnerFailureTrace;

  public constructor(message: string, trace: RunnerFailureTrace) {
    super(message);
    this.name = "RunnerInvocationError";
    this.trace = trace;
  }
}

export function runnerInvocationFailure(input: {
  readonly rejectedBeforeWork?: boolean;
  readonly message: string;
  readonly progress: RunnerProgressTracker;
  readonly reason: RunnerTerminationReason;
  readonly totalTimeoutMilliseconds?: number | undefined;
  readonly meaningfulOutputTimeoutMilliseconds: number;
  readonly protocolStop: RunnerFailureTrace["protocolStop"];
}): RunnerInvocationError {
  const failedAt = new Date().toISOString();
  return new RunnerInvocationError(input.message, {
    ...input.progress.snapshot(failedAt),
    ...(input.rejectedBeforeWork === true && input.progress.snapshot(failedAt).meaningfulUpdateCount === 0 ? {rejectedBeforeWork: true as const} : {}),
    failedAt,
    reason: input.reason,
    ...(input.totalTimeoutMilliseconds === undefined
      ? {}
      : { totalTimeoutMilliseconds: input.totalTimeoutMilliseconds }),
    meaningfulOutputTimeoutMilliseconds: input.meaningfulOutputTimeoutMilliseconds,
    protocolStop: input.protocolStop
  });
}

export const MAX_RUNNER_TIMEOUT_MILLISECONDS = 900_000;
const PROGRESS_EMIT_INTERVAL_MILLISECONDS = 1_000;

export function runnerTimeoutMilliseconds(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RUNNER_TIMEOUT_MILLISECONDS) {
    throw new Error(`${field} must be an integer between 1 and 900000`);
  }
  return value;
}

export function runnerMeaningfulTimeoutMilliseconds(
  value: number
): number {
  return runnerTimeoutMilliseconds(value, "meaningfulOutputTimeoutMilliseconds");
}

export class RunnerProgressTracker {
  readonly #onProgress: ((progress: RunnerProgress) => void) | undefined;
  readonly #startedAt: string;
  #lastMeaningfulAt: string;
  #sessionId: string | undefined;
  #phase: RunnerPhase = "starting";
  #updateCount = 0;
  #meaningfulUpdateCount = 0;
  #lastProgress: RunnerProgress["lastProgress"];
  #lastEmittedAtMilliseconds = 0;

  public constructor(startedAt: string, onProgress?: (progress: RunnerProgress) => void) {
    this.#startedAt = startedAt;
    this.#lastMeaningfulAt = startedAt;
    this.#onProgress = onProgress;
  }

  public session(sessionId: string): void {
    this.#sessionId = sessionId;
    this.#phase = "session_ready";
    this.observe("session", false);
    this.emit(true);
  }

  public phase(phase: RunnerPhase): void {
    this.#phase = phase;
    this.emit(true);
  }

  public observe(kind: RunnerProgressKind, meaningful: boolean): void {
    this.#updateCount = Math.min(Number.MAX_SAFE_INTEGER, this.#updateCount + 1);
    if (meaningful) {
      this.#meaningfulUpdateCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#meaningfulUpdateCount + 1
      );
      this.#lastMeaningfulAt = new Date().toISOString();
      this.#phase = "streaming";
    }
    this.#lastProgress = { kind };
    this.emit(false);
  }

  public snapshot(at = new Date().toISOString()): RunnerProgress {
    return {
      schemaVersion: "RunnerProgress@1",
      startedAt: this.#startedAt,
      observedAt: at,
      lastMeaningfulAt: this.#lastMeaningfulAt,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      phase: this.#phase,
      updateCount: this.#updateCount,
      meaningfulUpdateCount: this.#meaningfulUpdateCount,
      ...(this.#lastProgress === undefined ? {} : { lastProgress: this.#lastProgress })
    };
  }

  private emit(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.#lastEmittedAtMilliseconds <
      PROGRESS_EMIT_INTERVAL_MILLISECONDS) return;
    this.#lastEmittedAtMilliseconds = now;
    this.#onProgress?.(this.snapshot());
  }
}

export interface RunnerAssistantMessage {
  readonly text: string;
}

export interface RunnerToolCall {
  readonly name: string;
}

export interface RunnerUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

export type RunnerEvent =
  | { readonly type: "assistant.message"; readonly message: RunnerAssistantMessage }
  | { readonly type: "tool.observed"; readonly tool: RunnerToolCall }
  | { readonly type: "usage.updated"; readonly usage: RunnerUsage }
  | { readonly type: "turn.completed" };

export interface RunnerTurnReceipt {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sessionId: string;
  readonly toolEventsComplete: boolean;
  readonly events: readonly RunnerEvent[];
}

export interface AgentRunner {
  invoke(request: RunnerTurnRequest): Promise<RunnerTurnReceipt>;
}

export function runnerAssistantMessages(
  receipt: RunnerTurnReceipt
): readonly RunnerAssistantMessage[] {
  return receipt.events
    .filter((event) => event.type === "assistant.message")
    .map((event) => event.message);
}

export function runnerToolNames(receipt: RunnerTurnReceipt): readonly string[] {
  return receipt.events
    .filter((event) => event.type === "tool.observed")
    .map((event) => event.tool.name);
}

export function runnerUsage(receipt: RunnerTurnReceipt): RunnerUsage | undefined {
  return receipt.events.findLast((event) => event.type === "usage.updated")?.usage;
}

export function runnerTurnCount(receipt: RunnerTurnReceipt): number {
  return receipt.events.filter((event) => event.type === "turn.completed").length;
}
