import type { AgentRequestEvent } from "../../core/event/model.js";
import type { RuntimeStore } from "../../core/runtime/store.js";
import type { AgentRunProjection } from "../../modules/steward/state-machine.js";

export interface StewardRunIntervention {
  readonly schemaVersion: "RunIntervention@1";
  readonly kind: "manual_fallback";
  readonly runId: string;
  readonly runVersion: number;
  readonly requestEventId: string;
  readonly resultExecutionId: string;
  readonly reason: string;
  readonly allowedActions: readonly ("retry_orchestrator" | "decide" | "cancel")[];
}

// The settled continuation receipt owns fallback. Awaiting status alone does not.
export function stewardRunIntervention(
  run: AgentRunProjection,
  requests: readonly AgentRequestEvent[],
  runtime: RuntimeStore,
  at = new Date().toISOString()
): StewardRunIntervention | null {
  if (run.status !== "awaiting_orchestrator") return null;
  const request = requests.filter((event) =>
    event.runContext?.resultContractId.startsWith("run-decision@") &&
    event.runContext.cycleId === run.activeCycleId
  ).at(-1);
  if (request?.runContext === undefined) return null;
  const audit = runtime.audit(request.eventId);
  if (audit?.resultExecution?.status !== "succeeded") return null;
  const raw = runtime.executionReceiptJson(audit.resultExecution.executionId);
  if (raw === null) return null;
  const receipt = JSON.parse(raw) as Record<string, unknown>;
  if (receipt.schema !== "StewardOrchestratorDecisionReceipt@1" ||
    receipt.outcome !== "rejected_manual_fallback" || receipt.runId !== run.runId ||
    receipt.stepId !== request.runContext?.stepId || typeof receipt.error !== "string") {
    return null;
  }
  const retryable = run.orchestratorBinding?.schemaVersion === "OrchestratorBinding@3" &&
    run.stepCount === 0 && run.checkpoint === undefined &&
    run.activeStepId === request.runContext.stepId && run.workspaceGrant?.access !== "write" &&
    (run.deadlineAt === undefined || Date.parse(at) < Date.parse(run.deadlineAt));
  return {
    schemaVersion: "RunIntervention@1",
    kind: "manual_fallback",
    runId: run.runId,
    runVersion: run.version,
    requestEventId: request.eventId,
    resultExecutionId: audit.resultExecution.executionId,
    reason: receipt.error.slice(0, 4_096),
    allowedActions: [...(retryable ? ["retry_orchestrator" as const] : []), "decide", "cancel"]
  };
}
