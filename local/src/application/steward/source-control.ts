import { createHash } from "node:crypto";

import { RuntimeStore } from "../../core/runtime/store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { vikunjaRunResultDelivery } from
  "../../integrations/vikunja/task-destination.js";
import {
  latestOrchestratorState,
  type StewardOrchestratorBinding
} from "../../modules/steward/caller-contract.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";
import {
  newAgentRunCycleId,
  newAgentStepId,
  type AgentRunCycleProjection,
  type AgentRunProjection
} from "../../modules/steward/state-machine.js";
import {
  parseTriggerOccurrenceEnvelope,
  type TriggerOccurrenceEnvelope
} from "../../modules/steward/source-contract.js";
import type { StewardOrchestratorBindingV3 } from
  "../../modules/steward/run-contract-v3.js";
import { stewardOrchestratorPrompt } from "./prompt.js";

export interface ActivateRunSourceOccurrenceReceipt {
  readonly status: "accepted" | "duplicate";
  readonly run: AgentRunProjection;
  readonly cycle: AgentRunCycleProjection;
  readonly orchestratorEventId: string;
  readonly orchestratorExecutionId: string;
}

export function activateRunSourceOccurrenceInTransaction(input: {
  readonly runtime: RuntimeStore;
  readonly runs: AgentRunStore;
  readonly runId: string;
  readonly envelope: TriggerOccurrenceEnvelope | unknown;
  readonly at: string;
}): ActivateRunSourceOccurrenceReceipt {
  const envelope = parseTriggerOccurrenceEnvelope(input.envelope);
  const run = input.runs.requireProjection(input.runId);
  const binding = requireV3Binding(run);
  assertEnvelopeMatches(run, envelope);
  const requestId = occurrenceRequestId(run.runId, envelope.occurrenceKey);
  const existingCycle = input.runs.cycleByRequest(requestId);
  if (existingCycle !== undefined) {
    if (existingCycle.sourceEnvelope === undefined ||
      stableContractJson(existingCycle.sourceEnvelope) !== stableContractJson(envelope)) {
      throw new Error("Run occurrence request is already bound to another envelope");
    }
  }
  if (existingCycle === undefined &&
    (run.status !== "awaiting_source" || run.activeCycleId !== undefined)) {
    throw new Error(`Agent Run is not awaiting a source occurrence: ${run.runId}`);
  }
  const cycleId = existingCycle?.cycleId ?? newAgentRunCycleId();
  const stepId = existingCycle === undefined
    ? newAgentStepId()
    : input.runs.requireProjection(run.runId).activeStepId ?? newAgentStepId();
  const participantIds = run.mandate.participantAgentIds;
  if (participantIds === undefined) {
    throw new Error("Source-bound Steward Run requires a fixed participant roster");
  }
  const resultDelivery = binding.resultDestination === undefined
    ? undefined
    : optionalVikunjaDelivery(binding);
  const priorState = latestOrchestratorState(input.runs.decisions(run.runId));
  const admission = input.runtime.appendEventInTransaction({
    type: "agent.request",
    source: {
      kind: "handler",
      externalId: `agent-run:${run.runId}:occurrence:${requestId}`
    },
    agentId: binding.orchestratorRef.agentId,
    prompt: stewardOrchestratorPrompt({
      objective: run.mandate.kind === "objective"
        ? run.mandate.objective
        : run.mandate.renderedInstruction,
      runVersion: existingCycle === undefined ? run.version + 1 : run.version,
      maxSteps: run.maxSteps,
      completedWorkerSteps: 0,
      participants: input.runs.activeParticipantTargets(participantIds),
      contractVersion: 3,
      ...(binding.authority.trigger === undefined
        ? {}
        : { triggerKinds: binding.authority.trigger.allowedKinds }),
      sourceEnvelope: envelope,
      ...(priorState === undefined ? {} : { priorState }),
      ...(run.workspaceGrant?.effect === undefined
        ? {}
        : { workspaceEffect: run.workspaceGrant.effect }),
      ...(resultDelivery === undefined ? {} : { taskUrl: resultDelivery.taskUrl })
    }),
    runContext: {
      schemaVersion: "AgentRunContext@1",
      resultContractId: "run-decision@3",
      runId: run.runId,
      cycleId,
      stepId,
      depth: 0,
      ...(run.mandate.kind !== "workflow" || run.mandate.invocationBudget === undefined
        ? {}
        : { invocationBudget: run.mandate.invocationBudget }),
      ...(run.workspaceGrant === undefined ? {} : { workspaceGrant: run.workspaceGrant })
    },
    parent: {
      eventId: run.rootEventId,
      rootEventId: run.rootEventId,
      hop: 0
    },
    maxAttempts: 1,
    createdAt: input.at
  });
  if (existingCycle !== undefined) {
    if (admission.status !== "duplicate") {
      throw new Error("Existing Run occurrence unexpectedly admitted a second Event");
    }
    return {
      status: "duplicate",
      run: input.runs.requireProjection(run.runId),
      cycle: existingCycle,
      orchestratorEventId: admission.event.eventId,
      orchestratorExecutionId: admission.execution.executionId
    };
  }
  if (admission.status !== "accepted") {
    throw new Error("New Run occurrence unexpectedly matched an existing Event");
  }
  const cycle = input.runs.createCycleInTransaction({
    cycleId,
    runId: run.runId,
    requestId,
    sourceRevision: envelope.sourceRevision,
    mandate: run.mandate,
    ...(run.workspaceGrant === undefined ? {} : { workspaceGrant: run.workspaceGrant }),
    sourceEnvelope: envelope,
    initialStepCount: 0,
    createdAt: input.at
  });
  const activated = input.runs.activateSourceCycleInTransaction({
    runId: run.runId,
    expectedVersion: run.version,
    cycleId,
    mandate: run.mandate,
    ...(run.workspaceGrant === undefined ? {} : { workspaceGrant: run.workspaceGrant }),
    rootStepId: stepId,
    maxSteps: run.maxSteps,
    maxDepth: run.maxDepth,
    ...(run.deadlineAt === undefined ? {} : { deadlineAt: run.deadlineAt }),
    updatedAt: input.at
  });
  return {
    status: "accepted",
    run: activated,
    cycle,
    orchestratorEventId: admission.event.eventId,
    orchestratorExecutionId: admission.execution.executionId
  };
}

function requireV3Binding(
  run: AgentRunProjection
): StewardOrchestratorBindingV3 {
  if (run.orchestratorBinding?.schemaVersion !== "OrchestratorBinding@3" ||
    run.sourceBinding === undefined) {
    throw new Error("Agent Run is not bound to an OrchestratorBinding@3 source");
  }
  return run.orchestratorBinding;
}

function assertEnvelopeMatches(
  run: AgentRunProjection,
  envelope: TriggerOccurrenceEnvelope
): void {
  const binding = run.sourceBinding!;
  if (envelope.binding.runId !== run.runId ||
    envelope.binding.seriesKey !== binding.seriesKey ||
    envelope.binding.authorityDigest !== binding.authorityDigest ||
    stableContractJson(envelope.source) !== stableContractJson(binding.source)) {
    throw new Error("TriggerOccurrenceEnvelope does not match the Run source binding");
  }
}

function occurrenceRequestId(runId: string, occurrenceKey: string): string {
  const digest = createHash("sha256")
    .update(`${runId}\0${occurrenceKey}`)
    .digest("hex");
  return `source-occurrence:${digest}`;
}

function optionalVikunjaDelivery(
  binding: StewardOrchestratorBinding | StewardOrchestratorBindingV3
): ReturnType<typeof vikunjaRunResultDelivery> | undefined {
  if (binding.resultDestination?.delivery.kind !== "vikunja-task") return undefined;
  return vikunjaRunResultDelivery(binding.resultDestination);
}
