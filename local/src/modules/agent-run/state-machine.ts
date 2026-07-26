import { randomBytes } from "node:crypto";
import type { AgentTurnResult } from "./result-contract.js";

export interface AgentRunWorkspaceGrant {
  readonly schemaVersion: "ExternalWorkspaceGrant@1";
  readonly root: string;
  readonly access: "read" | "write";
  readonly revision: string;
}

export interface AgentRunTurnContext {
  readonly schemaVersion: "AgentRunContext@1";
  readonly runId: string;
  readonly stepId: string;
  readonly depth: number;
  readonly completionBinding?: {
    readonly schemaVersion: "AgentCompletionBinding@1";
    readonly callerAgentId: string;
    readonly callerSessionId: string;
    readonly callerStepId: string;
    readonly callerRequestEventId: string;
  };
}

export type AgentRunStatus =
  | "active"
  | "waiting"
  | "succeeded"
  | "failed"
  | "needs_human"
  | "cancelled";

export interface InlineRunMandateSnapshot {
  readonly schemaVersion: "RunMandateSnapshot@1";
  readonly kind: "objective";
  readonly objective: string;
  readonly renderedInstruction: string;
}

export interface WorkflowRunMandateSnapshot {
  readonly schemaVersion: "RunMandateSnapshot@1";
  readonly kind: "workflow";
  readonly workflowRef: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly renderedInstruction: string;
}

export type RunMandateSnapshot =
  | InlineRunMandateSnapshot
  | WorkflowRunMandateSnapshot;

export interface AgentRunProjection {
  readonly runId: string;
  readonly rootEventId: string;
  readonly ownerRequestId: string;
  readonly ownerPrincipalId: string;
  readonly stewardAgentId: string;
  readonly mandate: RunMandateSnapshot;
  readonly workspaceGrant?: AgentRunWorkspaceGrant;
  readonly status: AgentRunStatus;
  readonly activeStepId?: string;
  readonly activeExecutionId?: string;
  readonly stepCount: number;
  readonly maxSteps: number;
  readonly maxDepth: number;
  readonly deadlineAt?: string;
  readonly terminalSummary?: string;
  readonly cancelledAt?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentRunContinuationPlan =
  | { readonly kind: "ignore_cancelled" }
  | {
      readonly kind: "delegate";
      readonly nextStatus: "waiting";
      readonly nextStepCount: number;
    }
  | {
      readonly kind: "callback";
      readonly nextStatus: "active";
      readonly nextStepCount: number;
    }
  | {
      readonly kind: "terminal";
      readonly status: "succeeded" | "failed" | "needs_human";
      readonly summary: string;
    };

export function planAgentRunContinuation(input: {
  readonly run: AgentRunProjection;
  readonly context: AgentRunTurnContext;
  readonly result: AgentTurnResult;
  readonly now: string;
}): AgentRunContinuationPlan {
  const { run, context, result } = input;
  if (run.status === "cancelled") return { kind: "ignore_cancelled" };
  if (isTerminal(run.status)) {
    throw new Error(`Agent Run is already terminal: ${run.runId}`);
  }
  if (run.activeStepId !== context.stepId) {
    throw new Error(`Agent Run does not expect step: ${context.stepId}`);
  }
  if (run.deadlineAt !== undefined &&
    Date.parse(input.now) >= Date.parse(run.deadlineAt)) {
    return {
      kind: "terminal",
      status: "failed",
      summary: "Agent Run deadline exhausted"
    };
  }
  if (result.action === "delegate") {
    if (run.stepCount >= run.maxSteps) {
      return {
        kind: "terminal",
        status: "failed",
        summary: "Agent Run step budget exhausted"
      };
    }
    if (context.depth >= run.maxDepth) {
      return {
        kind: "terminal",
        status: "failed",
        summary: "Agent Run depth budget exhausted"
      };
    }
    return {
      kind: "delegate",
      nextStatus: "waiting",
      nextStepCount: run.stepCount + 1
    };
  }
  if (context.completionBinding !== undefined) {
    if (run.stepCount >= run.maxSteps) {
      return {
        kind: "terminal",
        status: "failed",
        summary: "Agent Run step budget exhausted before callback"
      };
    }
    return {
      kind: "callback",
      nextStatus: "active",
      nextStepCount: run.stepCount + 1
    };
  }
  return {
    kind: "terminal",
    status: result.outcome,
    summary: result.summary
  };
}

export function newAgentRunId(): string {
  return prefixedUuidV7("run");
}

export function newAgentStepId(): string {
  return prefixedUuidV7("stp");
}

export function requireAgentRunId(value: string): string {
  return requirePrefixedUuidV7(value, "run", "runId");
}

export function requireAgentStepId(value: string): string {
  return requirePrefixedUuidV7(value, "stp", "stepId");
}

export function isTerminal(status: AgentRunStatus): boolean {
  return status === "succeeded" ||
    status === "failed" ||
    status === "needs_human" ||
    status === "cancelled";
}

function prefixedUuidV7(prefix: "run" | "stp"): string {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((milliseconds >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requirePrefixedUuidV7(
  value: string,
  prefix: "run" | "stp",
  field: string
): string {
  if (!new RegExp(
    `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-` +
    `[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
  ).test(value)) {
    throw new Error(`${field} must be a ${prefix}_ UUIDv7`);
  }
  return value;
}
