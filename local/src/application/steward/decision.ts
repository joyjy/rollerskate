import { resumeNetworkCapabilityInTransaction } from "./capability.js";
import type { AgentResultEvent } from "../../core/event/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { workspaceRevision } from "../../infrastructure/workspace/revision.js";
import { enqueueTerminalRunDelivery } from "./result-destination.js";
import {
  isStewardOrchestrated,
  stewardDecisionVersion,
  type AgentRunDecisionReceipt,
  type AnyRunDecision
} from "../../modules/steward/caller-contract.js";
import {
  parseRunSourceBinding,
  type RunSourceBinding
} from "../../modules/steward/source-contract.js";
import { runAuthorityDigest } from
  "../../modules/steward/admission-contract.js";
import {
  newAgentStepId,
  planCallerRunDecision,
  type AgentRunProjection
} from "../../modules/steward/state-machine.js";
import { stepMandateSnapshot } from "./control-support.js";
import { callerOrchestratedStepPrompt } from "./prompt.js";

export interface AppliedRunDecision {
  readonly status: "accepted";
  readonly run: AgentRunProjection;
  readonly decision: AgentRunDecisionReceipt;
}

export interface StewardSourceBindingRegistrar {
  (input: {
    readonly run: AgentRunProjection;
    readonly decision: Extract<AnyRunDecision, {readonly action:"await_source"}>;
    readonly at: string;
  }): RunSourceBinding;
}

export function applyRunDecisionInTransaction(input: {
  readonly runtime: RuntimeStore;
  readonly runs: AgentRunStore;
  readonly run: AgentRunProjection;
  readonly decision: AnyRunDecision;
  readonly requestId: string;
  readonly sourceKind: "cli" | "handler";
  readonly parentResult?: AgentResultEvent;
  readonly bindSource?: StewardSourceBindingRegistrar;
  readonly at: string;
}): AppliedRunDecision {
  const { runtime, runs, run, decision, requestId, at } = input;
  if (input.sourceKind === "cli" && decision.schemaVersion !== "RunDecision@1") {
    throw new Error("Manual Owner must submit RunDecision@1");
  }
  if (input.sourceKind === "handler" && !isStewardOrchestrated(run.orchestratorBinding)) {
    throw new Error("Internal Steward Orchestrator requires a Steward binding");
  }
  const expectedInternalDecision = `RunDecision@${stewardDecisionVersion(run.orchestratorBinding)}`;
  if (input.sourceKind === "handler" && decision.schemaVersion !== expectedInternalDecision) {
    throw new Error(`Internal Steward Orchestrator must submit ${expectedInternalDecision}`);
  }
  const checkpoint = run.checkpoint;
  const sourceStepId = checkpoint?.stepId ?? run.activeStepId;
  if (sourceStepId === undefined) {
    throw new Error("Caller-orchestrated Run has no current decision source");
  }
  const plan = planCallerRunDecision({ run, decision, now: at });
  assertWorkspaceEffectSatisfied(run, plan);
  if (plan.kind === "request_capability") {
    if (input.parentResult === undefined || decision.action !== "request_capability") throw new Error("Capability request requires the Orchestrator result");
    const waiting = runs.waitForHumanInTransaction(run.runId, run.version, at);
    const receipt: AgentRunDecisionReceipt = {schemaVersion: "AgentRunDecisionReceipt@3", runId: run.runId, requestId,
      expectedRunVersion: run.version, resultingRunVersion: waiting.version, sourceStepId, action: "request_capability",
      questionId: input.parentResult.eventId, resultingRunStatus: "awaiting_orchestrator", acceptedAt: at};
    runs.recordDecisionInTransaction({runId: run.runId, requestId, decision, receipt});
    if (run.orchestratorBinding?.schemaVersion === "OrchestratorBinding@3" && run.orchestratorBinding.ownerNetworkAuthorized === true) {
      resumeNetworkCapabilityInTransaction({runtime, runs, run: waiting, result: input.parentResult,
        expectedVersion: waiting.version, at, authorization: "preauthorized"});
    }
    return {status: "accepted", run: runs.requireProjection(run.runId), decision: receipt};
  }
  if (plan.kind === "ask_human") {
    if (input.parentResult === undefined) throw new Error("Human question requires the settled Orchestrator result");
    const waiting = runs.waitForHumanInTransaction(run.runId,run.version,at);
    const receipt: AgentRunDecisionReceipt = {schemaVersion:"AgentRunDecisionReceipt@3",runId:run.runId,requestId,
      expectedRunVersion:run.version,resultingRunVersion:waiting.version,sourceStepId,action:"ask_human",
      questionId:input.parentResult.eventId,resultingRunStatus:"awaiting_orchestrator",acceptedAt:at};
    runs.recordDecisionInTransaction({runId:run.runId,requestId,decision,receipt});
    return {status:"accepted",run:waiting,decision:receipt};
  }
  if (plan.kind === "await_source") {
    if (decision.action !== "await_source" || input.bindSource === undefined) {
      throw new Error("RunDecision await_source requires a source owner registrar");
    }
    const binding = parseRunSourceBinding(input.bindSource({ run, decision, at }));
    if (binding.runId !== run.runId || binding.source.kind !== plan.sourceKind ||
      run.orchestratorBinding?.schemaVersion !== "OrchestratorBinding@3" ||
      binding.authorityDigest !== runAuthorityDigest(run.orchestratorBinding.authority)) {
      throw new Error("Run source binding exceeds or mismatches admitted authority");
    }
    const awaiting = runs.bindSourceInTransaction({
      runId: run.runId,
      expectedVersion: run.version,
      binding,
      updatedAt: at
    });
    const receipt: AgentRunDecisionReceipt = {
      schemaVersion: "AgentRunDecisionReceipt@2",
      runId: run.runId,
      requestId,
      expectedRunVersion: decision.expectedRunVersion,
      resultingRunVersion: awaiting.version,
      sourceStepId,
      action: "await_source",
      resultingRunStatus: "awaiting_source",
      sourceBinding: binding,
      acceptedAt: at
    };
    runs.recordDecisionInTransaction({ runId: run.runId, requestId, decision, receipt });
    return { status: "accepted", run: awaiting, decision: receipt };
  }
  if (plan.kind === "terminal") {
    if (decision.action !== "finish" && decision.action !== "needs_human") throw new Error("Terminal plan requires a terminal decision");
    const terminal = runs.terminalizeInTransaction({
      runId: run.runId,
      expectedVersion: run.version,
      status: plan.status,
      summary: plan.summary,
      scope: plan.scope,
      updatedAt: at
    });
    const receipt: AgentRunDecisionReceipt = (decision.schemaVersion === "RunDecision@3" || decision.schemaVersion === "RunDecision@4" || decision.schemaVersion === "RunDecision@5" || decision.schemaVersion === "RunDecision@6") ? {
      schemaVersion: "AgentRunDecisionReceipt@2",
      runId: run.runId,
      requestId,
      expectedRunVersion: decision.expectedRunVersion,
      resultingRunVersion: terminal.version,
      sourceStepId,
      action: decision.action,
      terminalStatus: plan.status,
      resultingRunStatus: terminal.status === "awaiting_source"
        ? "awaiting_source"
        : plan.status,
      ...(decision.action === "finish" ? { finishScope: plan.scope } : {}),
      ...(decision.action !== "finish" || run.activeCycleId === undefined
        ? {}
        : { cycleId: run.activeCycleId }),
      acceptedAt: at
    } : {
      schemaVersion: "AgentRunDecisionReceipt@1",
      runId: run.runId,
      requestId,
      expectedRunVersion: decision.expectedRunVersion,
      resultingRunVersion: terminal.version,
      sourceStepId,
      action: decision.action,
      terminalStatus: plan.status,
      acceptedAt: at
    };
    runs.recordDecisionInTransaction({ runId: run.runId, requestId, decision, receipt });
    enqueueTerminalRunDelivery(runtime, run, plan.status, plan.summary, at);
    return { status: "accepted", run: terminal, decision: receipt };
  }
  if (decision.action !== "next_step") {
    throw new Error("Caller next-step plan requires a next_step decision");
  }
  runs.requireActiveAgent(plan.targetAgentId);
  const mandate = stepMandateSnapshot(decision.nextStep.mandate);
  const stepId = newAgentStepId();
  const session = runtime.sessionForRunAgent(
    run.runId,
    plan.targetAgentId,
    run.activeCycleId
  );
  const parent = input.parentResult ?? (checkpoint === undefined
    ? runtime.event(run.rootEventId)
    : runtime.event(checkpoint.resultEventId));
  const validParentType = checkpoint === undefined
    ? parent?.type === "agent.request" || parent?.type === "agent.result"
    : parent?.type === "agent.result";
  if (!validParentType || parent?.causality.rootEventId !== run.rootEventId) {
    throw new Error("Agent Run decision causality is invalid");
  }
  const admission = runtime.appendEventInTransaction({
    type: "agent.request",
    source: {
      kind: input.sourceKind,
      externalId: `agent-run:${run.runId}:decision:${requestId}`
    },
    agentId: plan.targetAgentId,
    ...(session === undefined ? {} : { sessionId: session.sessionId }),
    prompt: callerOrchestratedStepPrompt(
      mandate.renderedInstruction,
      run.workspaceGrant?.effect
    ),
    runContext: {
      schemaVersion: "AgentRunContext@1",
      resultContractId: "agent-step-result@1",
      runId: run.runId,
      ...(run.activeCycleId === undefined ? {} : { cycleId: run.activeCycleId }),
      stepId,
      parentStepId: sourceStepId,
      depth: 0,
      ...(mandate.kind !== "workflow" || mandate.invocationBudget === undefined
        ? {}
        : { invocationBudget: mandate.invocationBudget }),
      ...(run.workspaceGrant === undefined ? {} : { workspaceGrant: run.workspaceGrant })
    },
    parent: {
      eventId: parent.eventId,
      rootEventId: parent.causality.rootEventId,
      hop: parent.causality.hop
    },
    maxAttempts: 1,
    createdAt: at
  });
  if (admission.status !== "accepted") {
    throw new Error("New RunDecision unexpectedly matched an existing Event");
  }
  const advanced = checkpoint === undefined
    ? runs.advanceInitialStewardInTransaction({
        runId: run.runId,
        expectedVersion: run.version,
        expectedStepId: sourceStepId,
        activeStepId: stepId,
        activeExecutionId: admission.execution.executionId,
        stepCount: plan.nextStepCount,
        updatedAt: at
      })
    : runs.advanceCallerInTransaction({
        runId: run.runId,
        expectedVersion: run.version,
        activeStepId: stepId,
        activeExecutionId: admission.execution.executionId,
        stepCount: plan.nextStepCount,
        updatedAt: at
      });
  const receipt: AgentRunDecisionReceipt = (decision.schemaVersion === "RunDecision@3" || decision.schemaVersion === "RunDecision@4" || decision.schemaVersion === "RunDecision@5" || decision.schemaVersion === "RunDecision@6") ? {
    schemaVersion: "AgentRunDecisionReceipt@2",
    runId: run.runId,
    requestId,
    expectedRunVersion: decision.expectedRunVersion,
    resultingRunVersion: advanced.version,
    sourceStepId,
    action: "next_step",
    targetAgentId: plan.targetAgentId,
    nextStepId: stepId,
    nextEventId: admission.event.eventId,
    nextExecutionId: admission.execution.executionId,
    resultingRunStatus: "active",
    acceptedAt: at
  } : {
    schemaVersion: "AgentRunDecisionReceipt@1",
    runId: run.runId,
    requestId,
    expectedRunVersion: decision.expectedRunVersion,
    resultingRunVersion: advanced.version,
    sourceStepId,
    action: "next_step",
    targetAgentId: plan.targetAgentId,
    nextStepId: stepId,
    nextEventId: admission.event.eventId,
    nextExecutionId: admission.execution.executionId,
    acceptedAt: at
  };
  runs.recordDecisionInTransaction({ runId: run.runId, requestId, decision, receipt });
  return { status: "accepted", run: advanced, decision: receipt };
}

export function assertWorkspaceEffectSatisfied(
  run: AgentRunProjection,
  plan: ReturnType<typeof planCallerRunDecision>
): void {
  if (plan.kind !== "terminal" || plan.status !== "succeeded" ||
    run.workspaceGrant?.effect !== "must_change") {
    return;
  }
  const observed = workspaceRevision(run.workspaceGrant.root).revision;
  if (observed === run.workspaceGrant.revision) {
    throw new Error(
      "workspace.effect=must_change requires a Runtime-observed revision change"
    );
  }
}
