import { assertAcceptanceSatisfied } from "./acceptance.js";
import { randomBytes } from "node:crypto";
import type {
  AgentRunCheckpoint,
  AnyRunDecision,
  CallerOrchestratorBinding
} from "./caller-contract.js";
import type { AgentTurnResult } from "./result-contract.js";
import type {
  RunSourceBinding,
  TriggerOccurrenceEnvelope
} from "./source-contract.js";

export interface AgentRunInvocationBudget {
  readonly schemaVersion: "AgentInvocationBudget@1";
  readonly totalTimeoutMilliseconds: number;
}

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
  readonly invocationBudget?: AgentRunInvocationBudget;
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
  readonly invocationBudget?: AgentRunInvocationBudget;
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
  readonly sourceBinding?: RunSourceBinding;
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
  readonly archivedAt?: string;
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
  readonly sourceEnvelope?: TriggerOccurrenceEnvelope;
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
  | { readonly kind: "request_capability" }
  | { readonly kind: "ask_human"; readonly question: string }
  | {
      readonly kind: "next_step";
      readonly targetAgentId: string;
      readonly nextStepCount: number;
    }
  | {
      readonly kind: "terminal";
      readonly status: "succeeded" | "failed" | "needs_human";
      readonly summary: string;
      readonly scope: "cycle" | "run";
    }
  | {
      readonly kind: "await_source";
      readonly sourceKind: "schedule" | "subscription" | "continuous_subscription";
      readonly templateId: string;
      readonly parameters: Readonly<Record<string, unknown>>;
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
    (run.orchestratorBinding.schemaVersion === "OrchestratorBinding@2" ||
      run.orchestratorBinding.schemaVersion === "OrchestratorBinding@3") &&
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
  if (run.orchestratorBinding.schemaVersion === "OrchestratorBinding@3" && run.orchestratorBinding.acceptanceContract !== undefined &&
    decision.action === "finish" && decision.finish.outcome === "succeeded" && decision.schemaVersion !== "RunDecision@6") {
    throw new Error("Original acceptance cannot be bypassed through an older decision contract");
  }
  if (decision.schemaVersion === "RunDecision@6") {
    const contract = run.orchestratorBinding.schemaVersion === "OrchestratorBinding@3"
      ? run.orchestratorBinding.acceptanceContract : undefined;
    if (contract === undefined) throw new Error("RunDecision@6 requires immutable original acceptance");
    if (decision.checkedAcceptance.some(check => !contract.items.some(item => item.id === check.id))) throw new Error("Unknown acceptance ID");
    if (decision.action === "finish" && decision.finish.outcome === "succeeded") {
      assertAcceptanceSatisfied(contract, decision.checkedAcceptance, decision.state.unresolvedQuestions);
    }
    if (decision.action === "request_capability") {
      if (run.workspaceGrant?.access !== "read" || run.workspaceGrant.networkAccess || run.sourceBinding !== undefined || run.activeCycleId !== undefined) throw new Error("Network adjustment requires a standalone read-only offline Run");
      if (run.deadlineAt !== undefined && Date.parse(input.now) >= Date.parse(run.deadlineAt)) throw new Error("Agent Run deadline exhausted");
      if (decision.capability.acceptanceIds.some(id => !contract.items.some(item => item.id === id))) throw new Error("Capability request has unknown acceptance ID");
      return {kind: "request_capability"};
    }
  }
  if (decision.action === "ask_human") {
    if (run.deadlineAt !== undefined && Date.parse(input.now) >= Date.parse(run.deadlineAt)) throw new Error("Agent Run deadline exhausted");
    return {kind:"ask_human",question:decision.question};
  }
  if (decision.action === "finish") {
    const scope = (decision.schemaVersion === "RunDecision@3" || decision.schemaVersion === "RunDecision@4" || decision.schemaVersion === "RunDecision@5" || decision.schemaVersion === "RunDecision@6")
      ? decision.finish.scope
      : run.activeCycleId === undefined ? "run" : "cycle";
    if (scope === "cycle" &&
      (run.sourceBinding === undefined || run.activeCycleId === undefined)) {
      throw new Error("finish(scope=cycle) requires an active source-bound cycle");
    }
    return {
      kind: "terminal",
      status: decision.finish.outcome,
      summary: decision.finish.summary,
      scope
    };
  }
  if (decision.action === "needs_human") {
    return {
      kind: "terminal",
      status: "needs_human",
      summary: decision.rationale,
      scope: "run"
    };
  }
  if (decision.action === "await_source") {
    if (run.orchestratorBinding.schemaVersion !== "OrchestratorBinding@3") {
      throw new Error("await_source requires OrchestratorBinding@3");
    }
    if (run.sourceBinding !== undefined || run.seriesKey !== undefined ||
      run.activeCycleId !== undefined) {
      throw new Error("Agent Run already has a source binding or series identity");
    }
    const allowedKinds = run.orchestratorBinding.authority.trigger?.allowedKinds ?? [];
    const admitted = decision.awaitSource.sourceKind === "schedule"
      ? allowedKinds.includes("once") || allowedKinds.includes("cron")
      : decision.awaitSource.sourceKind === "subscription"
        ? allowedKinds.includes("until")
        : allowedKinds.includes("continuous");
    if (!admitted) {
      throw new Error("RunDecision source kind exceeds admitted trigger authority");
    }
    return {
      kind: "await_source",
      sourceKind: decision.awaitSource.sourceKind,
      templateId: decision.awaitSource.templateId,
      parameters: decision.awaitSource.parameters
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
        run.orchestratorBinding.schemaVersion === "OrchestratorBinding@2" ||
          run.orchestratorBinding.schemaVersion === "OrchestratorBinding@3"
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
