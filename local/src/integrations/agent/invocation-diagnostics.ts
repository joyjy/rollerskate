import type {
  AgentInvocationDiagnostics,
  AgentTokenUsage,
  AgentToolUsage
} from "../../core/runtime/agent-invocation.js";
import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
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

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
