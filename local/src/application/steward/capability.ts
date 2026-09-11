import type { AgentResultEvent } from "../../core/event/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import type { AgentRunProjection } from "../../modules/steward/state-machine.js";
import { isTerminal } from "../../modules/steward/state-machine.js";
import { stewardOrchestratorContinuationPrompt } from "./orchestrator-retry.js";

export function runCapabilityRequest(run: AgentRunProjection, runs: AgentRunStore, runtime: RuntimeStore, at = new Date().toISOString()) {
  const record = runs.decisions(run.runId, 1)[0];
  if (record?.decision.action !== "request_capability" || record.receipt.schemaVersion !== "AgentRunDecisionReceipt@3") return null;
  const receipt = record.receipt;
  const event = runtime.eventsForRoot(run.rootEventId).find(e => e.source.externalId === `agent-run:${run.runId}:capability:${receipt.questionId}`);
  const status = event !== undefined ? "granted" as const : isTerminal(run.status) ? "closed" as const
    : run.deadlineAt !== undefined && Date.parse(at) >= Date.parse(run.deadlineAt) ? "expired" as const
    : run.version === receipt.resultingRunVersion && run.activeExecutionId === undefined ? "pending" as const : "superseded" as const;
  return {requestEventId: receipt.questionId, runVersion: receipt.resultingRunVersion, status,
    ...record.decision.capability, ...(event === undefined ? {} : {continuationEventId: event.eventId})};
}

export function resumeNetworkCapabilityInTransaction(input: {
  runtime: RuntimeStore; runs: AgentRunStore; run: AgentRunProjection;
  result: AgentResultEvent; expectedVersion: number; at: string; authorization: "owner-cli" | "preauthorized";
}) {
  const {runtime, runs, run, result, at} = input;
  const binding = run.orchestratorBinding;
  const pending = runCapabilityRequest(run, runs, runtime, at);
  if (pending?.requestEventId !== result.eventId || pending.status !== "pending" || pending.runVersion !== input.expectedVersion) throw new Error("Capability request is no longer pending at this version");
  if (binding?.schemaVersion !== "OrchestratorBinding@3" || binding.decisionContractId !== "run-decision@6") throw new Error("Capability adjustment requires RunDecision@6");
  if (input.authorization === "preauthorized" && binding.ownerNetworkAuthorized !== true) throw new Error("Network is not Owner authorized");
  if (run.deadlineAt !== undefined && Date.parse(at) >= Date.parse(run.deadlineAt)) throw new Error("Run deadline exhausted");
  const agents = runs.activeParticipantTargets(binding.authority.participantAgentIds);
  if (agents.length !== binding.authority.participantAgentIds.length || agents.some(a => a.client !== "codex")) throw new Error("Network adjustment requires active Codex participants");
  const request = result.causality.parentEventId === undefined ? undefined : runtime.event(result.causality.parentEventId);
  if (result.outcome !== "succeeded" || request?.type !== "agent.request" || request.runContext?.runId !== run.runId || request.agentId !== binding.orchestratorRef.agentId) throw new Error("Invalid capability producer");
  const resumed = runs.resumeNetworkCapabilityInTransaction(run.runId, input.expectedVersion, result.eventId, at);
  // Codex applies the new read-only network policy on turn/start, including resumed Sessions.
  const admission = runtime.appendEventInTransaction({type: "agent.request", agentId: request.agentId,
    ...(result.sessionId === undefined ? {} : {sessionId: result.sessionId}),
    source: {kind: input.authorization === "owner-cli" ? "cli" : "handler", externalId: `agent-run:${run.runId}:capability:${result.eventId}`},
    prompt: [stewardOrchestratorContinuationPrompt(runs, resumed),
      "Owner-authorized network capability is now enabled. Continue the original acceptance from preserved state and checkpoint; do not repeat completed work.",
      JSON.stringify({authorization: input.authorization, requestEventId: result.eventId, targets: pending.targets,
        priorAdmissionDigest: binding.admissionDigest,
        admittedDigest: resumed.orchestratorBinding?.schemaVersion === "OrchestratorBinding@3" ? resumed.orchestratorBinding.admissionDigest : null,
        priorAuthority: binding.authority, admittedAuthority: resumed.orchestratorBinding?.schemaVersion === "OrchestratorBinding@3" ? resumed.orchestratorBinding.authority : null})].join("\n"),
    runContext: {...request.runContext, workspaceGrant: resumed.workspaceGrant!},
    parent: {eventId: result.eventId, rootEventId: run.rootEventId, hop: result.causality.hop}, maxAttempts: 1, createdAt: at});
  if (admission.status !== "accepted") throw new Error("Unexpected duplicate capability continuation");
  return {status: "accepted" as const, runId: run.runId, version: resumed.version, eventId: admission.event.eventId};
}

export function authorizeRunNetwork(repoRoot: string, runId: string, requestEventId: string, expectedVersion: number, runtimeDirectory?: string) {
  const db = openRuntimeDatabase(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const runtime = new RuntimeStore(db), runs = new AgentRunStore(db);
    return runtime.withImmediateTransaction(() => {
      const run = runs.requireProjection(runId);
      const prior = runtime.eventsForRoot(run.rootEventId).find(e => e.source.externalId === `agent-run:${runId}:capability:${requestEventId}`);
      if (prior !== undefined) return {status: "already_applied", runId, eventId: prior.eventId};
      const result = runtime.event(requestEventId);
      if (result?.type !== "agent.result" || runtime.executionForEvent(result.eventId)?.status !== "succeeded") throw new Error("Capability request result is not settled");
      return resumeNetworkCapabilityInTransaction({runtime, runs, run, result, expectedVersion, at: new Date().toISOString(), authorization: "owner-cli"});
    });
  } finally { db.close(); }
}
