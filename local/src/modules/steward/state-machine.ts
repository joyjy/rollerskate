import { randomBytes } from "node:crypto";
import type {
  AgentRunCheckpoint,
  AnyRunDecision,
  CallerOrchestratorBinding
} from "./caller-contract.js";
import type { AgentTurnResult } from "./result-contract.js";

export type AgentRunWorkspaceEffect =
  "must_change" | "may_remain_unchanged";

export interface AgentRunWorkspaceGrant {
  readonly schemaVersion: "ExternalWorkspaceGrant@1";
  readonly root: string;
  readonly access: "read" | "write";
  readonly effect?: AgentRunWorkspaceEffect;
  readonly networkAccess?: boolean;
  readonly revision: string;
}

export interface AgentRunTurnContext {
  readonly schemaVersion: "AgentRunContext@1";
  readonly runId: string;
  readonly cycleId?: string;
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
  | "awaiting_orchestrator"
  | "awaiting_source"
  | "succeeded"
  | "failed"
  | "needs_human"
  | "cancelled";

export interface InlineRunMandateSnapshot {
  readonly schemaVersion: "RunMandateSnapshot@1";
  readonly kind: "objective";
  readonly objective: string;
  readonly renderedInstruction: string;
  readonly participantAgentIds?: readonly string[];
}

export interface WorkflowRunMandateSnapshot {
  readonly schemaVersion: "RunMandateSnapshot@1";
  readonly kind: "workflow";
  readonly workflowRef: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly renderedInstruction: string;
  readonly participantAgentIds?: readonly string[];
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
  readonly seriesKey?: string;
  readonly activeCycleId?: string;
  readonly mandate: RunMandateSnapshot;
  readonly workspaceGrant?: AgentRunWorkspaceGrant;
  readonly orchestrationMode: "autonomous" | "caller";
  readonly orchestratorBinding?: CallerOrchestratorBinding;
  readonly status: AgentRunStatus;
  readonly activeStepId?: string;
  readonly activeExecutionId?: string;
  readonly stepCount: number;
  readonly maxSteps: number;
  readonly maxDepth: number;
  readonly deadlineAt?: string;
  readonly checkpoint?: AgentRunCheckpoint;
  readonly terminalSummary?: string;
  readonly cancelledAt?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentRunCycleStatus =
  | "active"
  | "succeeded"
  | "failed"
  | "needs_human"
  | "superseded"
  | "cancelled";

export interface AgentRunCycleProjection {
  readonly cycleId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly sourceRevision: string;
  readonly mandate: RunMandateSnapshot;
  readonly workspaceGrant?: AgentRunWorkspaceGrant;
  readonly status: AgentRunCycleStatus;
  readonly stepCount: number;
  readonly terminalSummary?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
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
  if (run.orchestrationMode !== "autonomous") {
    throw new Error("Autonomous continuation requires an autonomous Agent Run");
  }
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

export type CallerRunDecisionPlan =
  | {
      readonly kind: "next_step";
      readonly targetAgentId: string;
      readonly nextStepCount: number;
    }
  | {
      readonly kind: "terminal";
      readonly status: "succeeded" | "failed" | "needs_human";
      readonly summary: string;
    };

export function planCallerRunDecision(input: {
  readonly run: AgentRunProjection;
  readonly decision: AnyRunDecision;
  readonly now: string;
}): CallerRunDecisionPlan {
  const { run, decision } = input;
  if (run.orchestrationMode !== "caller" || run.orchestratorBinding === undefined) {
    throw new Error("Run is not caller-orchestrated");
  }
  const initialStewardDecision =
    run.orchestratorBinding.schemaVersion === "OrchestratorBinding@2" &&
    run.stepCount === 0 &&
    run.checkpoint === undefined &&
    (run.status === "active" || run.status === "awaiting_orchestrator");
  if (!initialStewardDecision &&
    (run.status !== "awaiting_orchestrator" || run.checkpoint === undefined)) {
    throw new Error("Caller-orchestrated Run is not awaiting a decision");
  }
  if (run.version !== decision.expectedRunVersion) {
    throw new Error(
      `RunDecision expected version ${decision.expectedRunVersion} but current is ${run.version}`
    );
  }
  if (decision.action === "finish") {
    return {
      kind: "terminal",
      status: decision.finish.outcome,
      summary: decision.finish.summary
    };
  }
  if (decision.action === "needs_human") {
    return {
      kind: "terminal",
      status: "needs_human",
      summary: decision.rationale
    };
  }
  if (run.deadlineAt !== undefined &&
    Date.parse(input.now) >= Date.parse(run.deadlineAt)) {
    throw new Error("Agent Run deadline exhausted");
  }
  if (run.stepCount >= run.maxSteps) {
    throw new Error("Agent Run step budget exhausted");
  }
  const targetAgentId = decision.nextStep.target.kind === "self"
    ? run.checkpoint?.agentId ?? (
        run.orchestratorBinding.schemaVersion === "OrchestratorBinding@2"
          ? run.orchestratorBinding.orchestratorRef.agentId
          : undefined
      )
    : decision.nextStep.target.agentId;
  if (targetAgentId === undefined) {
    throw new Error("RunDecision self target has no current Agent");
  }
  if (run.mandate.participantAgentIds === undefined ||
    !run.mandate.participantAgentIds.includes(targetAgentId)) {
    throw new Error("RunDecision target is outside the admitted participant roster");
  }
  return {
    kind: "next_step",
    targetAgentId,
    nextStepCount: run.stepCount + 1
  };
}

export function newAgentRunId(): string {
  return prefixedUuidV7("run");
}

export function newAgentStepId(): string {
  return prefixedUuidV7("stp");
}

export function newAgentRunCycleId(): string {
  return prefixedUuidV7("cyc");
}

export function requireAgentRunId(value: string): string {
  return requirePrefixedUuidV7(value, "run", "runId");
}

export function requireAgentStepId(value: string): string {
  return requirePrefixedUuidV7(value, "stp", "stepId");
}

export function requireAgentRunCycleId(value: string): string {
  return requirePrefixedUuidV7(value, "cyc", "cycleId");
}

export function isTerminal(status: AgentRunStatus): boolean {
  return status === "succeeded" ||
    status === "failed" ||
    status === "needs_human" ||
    status === "cancelled";
}

function prefixedUuidV7(prefix: "run" | "stp" | "cyc"): string {
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
  prefix: "run" | "stp" | "cyc",
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
