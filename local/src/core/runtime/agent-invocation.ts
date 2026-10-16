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
  readonly rejectedBeforeWork?: true;
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

/** Provider rejected a request before any model turn/tool execution; adapter-owned evidence. */
export class AgentNetworkError extends Error {
  public constructor(message: string, public readonly adapterId: string, public readonly workspace: string) {
    super(message);
    this.name = "AgentNetworkError";
  }
}

/** Match transport/provider errors, never arbitrary timeouts or auth/configuration failures. */
export function isTransientNetworkFailure(message: string): boolean {
  if (/\b(?:401|403)\b|unauthorized|forbidden|invalid.api.key|authentication|permission denied/iu.test(message)) return false;
  return /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|\b(?:HTTP|status|API(?:Error| error)?)[ :_=-]*(?:429|500|502|503|504)\b|\b(?:rate.limit(?:ed| exceeded)?|too many requests|service unavailable|bad gateway|gateway timeout)\b/iu.test(message);
}

/** Public provider output only; hidden reasoning must never be passed as data. */
export interface AgentOutputEvent {
  readonly kind: "assistant.delta" | "assistant.message" | "tool.call" | "tool.update" | "tool.result" | "thought";
  readonly data?: unknown;
}

export interface AgentInvocationJournal {
  append(kind: string, data?: unknown): void;
  close(): void;
}

export interface AgentAdapterInput {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId?: string;
  readonly reportProgress?: (progress: AgentInvocationProgress) => void;
  readonly reportOutput?: (event: AgentOutputEvent) => void;
}

export interface ProviderPolicyObservationSnapshot {
  readonly client: string;
  readonly controls: Readonly<Record<string, string | boolean>>;
  readonly hook: {
    readonly state: "enforced" | "ignored" | "fail-open" | "missing";
    readonly helperDigest?: string;
  };
}

/** A resumed execution must not silently switch to a new provider conversation. */
export function assertProviderSessionIdentity(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error("Resumed provider Session identity does not match the request");
  }
}
