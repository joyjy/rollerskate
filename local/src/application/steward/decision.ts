import type { AgentResultEvent } from "../../core/event/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { vikunjaRunResultDelivery } from
  "../../integrations/vikunja/task-destination.js";
import { workspaceRevision } from "../../infrastructure/workspace/revision.js";
import {
  isStewardOrchestrated,
  type AgentRunDecisionReceipt,
  type AnyRunDecision
} from "../../modules/steward/caller-contract.js";
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

export function applyRunDecisionInTransaction(input: {
  readonly runtime: RuntimeStore;
  readonly runs: AgentRunStore;
  readonly run: AgentRunProjection;
  readonly decision: AnyRunDecision;
  readonly requestId: string;
  readonly sourceKind: "cli" | "handler";
  readonly parentResult?: AgentResultEvent;
  readonly at: string;
}): AppliedRunDecision {
  const { runtime, runs, run, decision, requestId, at } = input;
  if (input.sourceKind === "cli" && decision.schemaVersion !== "RunDecision@1") {
    throw new Error("Manual Owner must submit RunDecision@1");
  }
  if (input.sourceKind === "handler" &&
    (!isStewardOrchestrated(run.orchestratorBinding) ||
      decision.schemaVersion !== "RunDecision@2")) {
    throw new Error("Internal Steward Orchestrator must submit RunDecision@2");
  }
  const checkpoint = run.checkpoint;
  const sourceStepId = checkpoint?.stepId ?? run.activeStepId;
  if (sourceStepId === undefined) {
    throw new Error("Caller-orchestrated Run has no current decision source");
  }
  const plan = planCallerRunDecision({ run, decision, now: at });
  assertWorkspaceEffectSatisfied(run, plan);
  if (plan.kind === "terminal") {
    const terminal = runs.terminalizeInTransaction({
      runId: run.runId,
      expectedVersion: run.version,
      status: plan.status,
      summary: plan.summary,
      updatedAt: at
    });
    const receipt: AgentRunDecisionReceipt = {
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
    if (isStewardOrchestrated(run.orchestratorBinding) &&
      run.orchestratorBinding.resultDestination !== undefined) {
      const destination = run.orchestratorBinding.resultDestination;
      const delivery = vikunjaRunResultDelivery(destination);
      runtime.enqueueHostDeliveryInTransaction({
        originId: `steward-run:${run.runId}:terminal`,
        destinationId: destination.destinationId,
        kind: delivery.kind,
        address: delivery.address,
        payload: {
          schemaVersion: "VikunjaTaskComment@1",
          runId: run.runId,
          body: `Rollerskate Run ${run.runId}: ${plan.status}\n\n${plan.summary}`
        },
        at
      });
    }
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
  const receipt: AgentRunDecisionReceipt = {
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
