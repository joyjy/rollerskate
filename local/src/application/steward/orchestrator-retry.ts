import type {
  AgentRequestEvent,
  AgentResultEvent,
  EventSource
} from "../../core/event/model.js";
import type { RuntimeExecution } from "../../core/runtime/model.js";
import {
  RuntimeStore,
  type AppendRuntimeEventReceipt
} from "../../core/runtime/store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { vikunjaRunResultDelivery } from
  "../../integrations/vikunja/task-destination.js";
import {
  isStewardOrchestrated,
  latestOrchestratorState
} from "../../modules/steward/caller-contract.js";
import type { AgentRunProjection } from
  "../../modules/steward/state-machine.js";
import { stewardOrchestratorPrompt } from "./prompt.js";

export interface StewardOrchestratorRetryReceipt {
  readonly status: AppendRuntimeEventReceipt["status"];
  readonly eventId: string;
  readonly executionId: string;
  readonly resumedSession: boolean;
}

export function queueStewardOrchestratorRetryInTransaction(input: {
  readonly runtime: RuntimeStore;
  readonly request: AgentRequestEvent;
  readonly result: AgentResultEvent;
  readonly agentExecution: RuntimeExecution;
  readonly source: EventSource;
  readonly prompt?: string;
  readonly at: string;
}): StewardOrchestratorRetryReceipt {
  const context = input.request.runContext;
  if (context === undefined || !context.resultContractId.startsWith("run-decision@")) {
    throw new Error("Steward Orchestrator retry requires a RunDecision request");
  }
  if (context.workspaceGrant?.access === "write") {
    throw new Error("Steward Orchestrator retry is read-only only");
  }
  if (input.result.causality.parentEventId !== input.request.eventId ||
    input.result.causality.rootEventId !== input.request.causality.rootEventId) {
    throw new Error("Steward Orchestrator retry causality is invalid");
  }
  if (input.agentExecution.eventId !== input.request.eventId ||
    input.agentExecution.handler !== "agent" ||
    !["succeeded", "failed"].includes(input.agentExecution.status)) {
    throw new Error("Steward Orchestrator retry requires a terminal Agent Execution");
  }
  const priorSessionId = input.result.sessionId ?? input.request.sessionId;
  const recoveredSession = priorSessionId === undefined
    ? input.runtime.recoverReadOnlySessionInTransaction(
        input.agentExecution.executionId,
        input.at
      )
    : undefined;
  const sessionId = priorSessionId ?? recoveredSession?.sessionId;
  const admission = input.runtime.appendEventInTransaction({
    type: "agent.request",
    source: input.source,
    agentId: input.request.agentId,
    prompt: input.prompt ?? input.request.prompt,
    ...(sessionId === undefined ? {} : { sessionId }),
    runContext: context,
    parent: {
      eventId: input.result.eventId,
      rootEventId: input.result.causality.rootEventId,
      hop: input.result.causality.hop
    },
    maxAttempts: 1,
    createdAt: input.at
  });
  return {
    status: admission.status,
    eventId: admission.event.eventId,
    executionId: admission.execution.executionId,
    resumedSession: sessionId !== undefined
  };
}

export function stewardOrchestratorRetryPrompt(
  runs: AgentRunStore,
  run: AgentRunProjection
): string {
  const binding = run.orchestratorBinding;
  const participantIds = run.mandate.participantAgentIds;
  if (!isStewardOrchestrated(binding) || participantIds === undefined) {
    throw new Error("Run is not fixed-roster Steward orchestration");
  }
  const resultDelivery = binding.resultDestination === undefined
    ? undefined
    : vikunjaRunResultDelivery(binding.resultDestination);
  const priorState = latestOrchestratorState(runs.decisions(run.runId));
  const sourceEnvelope = run.activeCycleId === undefined
    ? undefined
    : runs.cycle(run.activeCycleId)?.sourceEnvelope;
  return stewardOrchestratorPrompt({
    objective: run.mandate.kind === "objective"
      ? run.mandate.objective
      : run.mandate.renderedInstruction,
    runVersion: run.version,
    maxSteps: run.maxSteps,
    completedWorkerSteps: run.stepCount,
    participants: runs.activeParticipantTargets(participantIds),
    contractVersion: binding.schemaVersion === "OrchestratorBinding@3" ? 3 : 2,
    ...(priorState === undefined ? {} : { priorState }),
    ...(binding.schemaVersion !== "OrchestratorBinding@3" ||
      binding.authority.trigger === undefined
      ? {}
      : { triggerKinds: binding.authority.trigger.allowedKinds }),
    ...(sourceEnvelope === undefined ? {} : { sourceEnvelope }),
    ...(run.workspaceGrant?.effect === undefined
      ? {}
      : { workspaceEffect: run.workspaceGrant.effect }),
    ...(resultDelivery === undefined ? {} : { taskUrl: resultDelivery.taskUrl })
  });
}
