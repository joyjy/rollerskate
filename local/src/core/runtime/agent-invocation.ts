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

interface AgentInvocationProgressBase {
  readonly adapterId: string;
  readonly workspace: string;
  readonly workspaceAccess: "read" | "write";
  readonly providerSessionId?: string;
  readonly startedAt: string;
  readonly observedAt: string;
  readonly lastMeaningfulAt: string;
  readonly phase:
    | "starting"
    | "session_ready"
    | "prompting"
    | "streaming"
    | "cancelling"
    | "terminated";
  readonly updateCount: number;
  readonly meaningfulUpdateCount: number;
  readonly lastProgress?: {
    readonly kind: "session" | "assistant" | "thought" | "tool" | "plan" | "protocol";
  };
}

export interface AgentInvocationProgress extends AgentInvocationProgressBase {
  readonly schemaVersion: "AgentInvocationProgress@1";
}

export interface AgentInvocationFailure extends AgentInvocationProgressBase {
  readonly schemaVersion: "AgentInvocationFailure@1";
  readonly failedAt: string;
  readonly reason: "stall" | "deadline" | "protocol_exit" | "cancelled" | "protocol_error";
  readonly totalTimeoutMilliseconds?: number;
  readonly meaningfulOutputTimeoutMilliseconds: number;
  readonly protocolStop: "requested" | "acknowledged" | "unavailable";
  readonly recovery: "explicit_read_only_resume" | "unknown_outcome_no_replay" | "none";
}

export class AgentInvocationError extends Error {
  public readonly failure: AgentInvocationFailure;

  public constructor(message: string, failure: AgentInvocationFailure) {
    super(message);
    this.name = "AgentInvocationError";
    this.failure = failure;
  }
}

export interface AgentAdapterInput {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId?: string;
  readonly reportProgress?: (progress: AgentInvocationProgress) => void;
}

export interface ProviderPolicyObservationSnapshot {
  readonly client: string;
  readonly controls: Readonly<Record<string, string | boolean>>;
  readonly hook: {
    readonly state: "enforced" | "ignored" | "fail-open" | "missing";
    readonly helperDigest?: string;
  };
}
