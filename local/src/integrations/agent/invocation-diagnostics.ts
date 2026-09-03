import type {
  AgentInvocationFailure,
  AgentInvocationProgress,
  AgentInvocationDiagnostics,
  AgentTokenUsage,
  AgentToolUsage
} from "../../core/runtime/agent-invocation.js";
import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import type {
  RunnerFailureTrace,
  RunnerProgress
} from "./runner/protocol.js";
import { runtimeAgentEventPrompt } from "./event-prompt.js";

interface InvocationTimingReceipt {
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ProviderInvocationDiagnostics {
  readonly tokenUsage?: AgentTokenUsage;
  readonly toolUsage?: readonly AgentToolUsage[];
  readonly turnCount?: number;
}

export function invocationDiagnostics(
  event: AgentInputEvent | ChatDispatchEvent,
  receipt: InvocationTimingReceipt,
  provider: ProviderInvocationDiagnostics = {}
): AgentInvocationDiagnostics {
  const started = Date.parse(receipt.startedAt);
  const completed = Date.parse(receipt.completedAt);
  return {
    schemaVersion: "AgentInvocationDiagnostics@1",
    effectivePrompt: bounded(runtimeAgentEventPrompt(event), 32_768),
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    durationMilliseconds: Math.max(0, completed - started),
    ...(provider.tokenUsage === undefined ? {} : { tokenUsage: provider.tokenUsage }),
    ...(provider.toolUsage === undefined ? {} : { toolUsage: provider.toolUsage }),
    ...(provider.turnCount === undefined ? {} : { turnCount: provider.turnCount })
  };
}

export function countedTools(names: readonly string[]): readonly AgentToolUsage[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => ({ name, count }));
}

export class BoundedToolUsage {
  readonly #counts = new Map<string, number>();
  #complete = true;

  public record(name: string): void {
    if (Buffer.byteLength(name, "utf8") > 256 ||
      (!this.#counts.has(name) && this.#counts.size >= 64)) {
      this.#complete = false;
      return;
    }
    this.#counts.set(name, Math.min(
      Number.MAX_SAFE_INTEGER,
      (this.#counts.get(name) ?? 0) + 1
    ));
  }

  public invalidate(): void {
    this.#complete = false;
  }

  public result(): readonly AgentToolUsage[] | undefined {
    if (!this.#complete) return undefined;
    return [...this.#counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count }));
  }
}

export function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function invocationTimeoutMilliseconds(
  event: AgentInputEvent | ChatDispatchEvent
): number | undefined {
  const configured = event.type === "agent.request"
    ? event.runContext?.invocationBudget?.totalTimeoutMilliseconds
    : undefined;
  return configured === undefined ? undefined : boundedTimeout(configured);
}

export function agentInvocationProgress(input: {
  readonly adapterId: string;
  readonly workspace: string;
  readonly workspaceAccess: "read" | "write";
  readonly progress: RunnerProgress;
  readonly providerSessionId?: string;
}): AgentInvocationProgress {
  return {
    schemaVersion: "AgentInvocationProgress@1",
    adapterId: input.adapterId,
    workspace: input.workspace,
    workspaceAccess: input.workspaceAccess,
    ...(input.providerSessionId === undefined
      ? {}
      : { providerSessionId: input.providerSessionId }),
    startedAt: input.progress.startedAt,
    observedAt: input.progress.observedAt,
    lastMeaningfulAt: input.progress.lastMeaningfulAt,
    phase: input.progress.phase,
    updateCount: input.progress.updateCount,
    meaningfulUpdateCount: input.progress.meaningfulUpdateCount,
    ...(input.progress.lastProgress === undefined
      ? {}
      : { lastProgress: input.progress.lastProgress })
  };
}

export function agentInvocationFailure(input: {
  readonly adapterId: string;
  readonly workspace: string;
  readonly workspaceAccess: "read" | "write";
  readonly trace: RunnerFailureTrace;
  readonly providerSessionId?: string;
}): AgentInvocationFailure {
  const progress = agentInvocationProgress({
    adapterId: input.adapterId,
    workspace: input.workspace,
    workspaceAccess: input.workspaceAccess,
    progress: input.trace,
    ...(input.providerSessionId === undefined
      ? {}
      : { providerSessionId: input.providerSessionId })
  });
  return {
    ...progress,
    schemaVersion: "AgentInvocationFailure@1",
    failedAt: input.trace.failedAt,
    reason: input.trace.reason,
    ...(input.trace.totalTimeoutMilliseconds === undefined
      ? {}
      : { totalTimeoutMilliseconds: input.trace.totalTimeoutMilliseconds }),
    meaningfulOutputTimeoutMilliseconds: input.trace.meaningfulOutputTimeoutMilliseconds,
    protocolStop: input.trace.protocolStop,
    recovery: input.workspaceAccess === "write"
      ? "unknown_outcome_no_replay"
      : input.trace.sessionId === undefined
        ? "none"
        : "explicit_read_only_resume"
  };
}

function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 900_000) {
    throw new Error("totalTimeoutMilliseconds must be an integer between 1 and 900000");
  }
  return value;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
