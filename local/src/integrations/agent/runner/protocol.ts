export interface RunnerTurnRequest {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly workspaceAccess: "read" | "write";
  readonly model?: string;
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
