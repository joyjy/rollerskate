import type { AgentResultEvent } from "../../core/event/model.js";
import { parseAgentStepResult, type AgentStepResult } from "../../modules/steward/caller-contract.js";
import {
  inlineMandateSnapshot,
  workflowMandateSnapshot
} from "../../infrastructure/resources/workflow-resource.js";
import type { RunDecisionMandate } from "../../modules/steward/caller-contract.js";

export function stepMandateSnapshot(mandate: RunDecisionMandate) {
  return mandate.kind === "objective"
    ? inlineMandateSnapshot(mandate.objective)
    : workflowMandateSnapshot(mandate.workflowRef, mandate.inputs);
}

export function callerStepResult(result: AgentResultEvent): AgentStepResult {
  if (result.outcome !== "succeeded") return {schemaVersion: "AgentStepResult@1", outcome: "failed", summary: (result.error ?? "Agent provider failed").slice(0, 4096), artifactRefs: []};
  try { return parseAgentStepResult(result.output ?? ""); }
  catch (error) { return {schemaVersion: "AgentStepResult@1", outcome: "failed", summary: `Invalid AgentStepResult@1: ${String(error)}`.slice(0, 4096), artifactRefs: []}; }
}
