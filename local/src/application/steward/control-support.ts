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
