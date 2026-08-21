import type { AgentInputEvent, ChatDispatchEvent } from "../event/model.js";

export interface AgentTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

export interface AgentToolUsage {
  readonly name: string;
  readonly count: number;
}

export interface AgentInvocationDiagnostics {
  readonly schemaVersion: "AgentInvocationDiagnostics@1";
  readonly effectivePrompt: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMilliseconds: number;
  readonly tokenUsage?: AgentTokenUsage;
  readonly toolUsage?: readonly AgentToolUsage[];
  readonly turnCount?: number;
}

export interface AgentAdapterInvocation {
  readonly providerSessionId: string;
  readonly outcome:
    | { readonly kind: "message"; readonly body: string }
    | { readonly kind: "silent" };
  readonly invocation?: AgentInvocationDiagnostics;
}

export interface AgentAdapterInput {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId?: string;
}

export interface ProviderPolicyObservationSnapshot {
  readonly client: string;
  readonly controls: Readonly<Record<string, string | boolean>>;
  readonly hook: {
    readonly state: "enforced" | "ignored" | "fail-open" | "missing";
    readonly helperDigest?: string;
  };
}
