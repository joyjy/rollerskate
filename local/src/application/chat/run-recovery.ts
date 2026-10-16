import { createHash } from "node:crypto";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import type { ChatActivationEvent, ChatDispatchEvent } from "../../core/event/model.js";
import { runRecoveryStore } from "../../infrastructure/files/run-recovery-store.js";
import { parseRunDecision } from "../../modules/steward/caller-contract.js";
import { inspectStewardRunView } from "../steward/query.js";
import { validateCallerRunDecision, submitCallerRunDecision } from "../steward/control.js";
import { inspectChatRunOrigin, requireChatRunOrigin, type ChatWorkQueryContext } from "./work-query.js";

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function chatRunRecoveryToolRequirement(runtime: Pick<RuntimeStore,"event">, event: ChatDispatchEvent) {
  const activation = runtime.event(event.sourceAttentionEventId);
  if (activation?.type !== "chat.activation" || !isChatRunRecoveryActivation(activation)) return undefined;
  return {
    name: "prepare_chat_run_recovery",
    successStatus: "prepared",
    reminder: [
      "The requested recovery proposal was not recorded.",
      "Before returning the Chat decision, return exactly one ChatToolRequest@1 for prepare_chat_run_recovery.",
      "Do not claim the tool was called unless the Rollerskate tool result reports status=prepared."
    ].join(" ")
  };
}

export function isChatRunRecoveryActivation(activation: ChatActivationEvent) {
  return activation.reason === "work_result" && activation.strategyId === "work-result" &&
    activation.source.externalId?.startsWith("chat-activation:chat-run-recovery:") === true;
}
function readProposal(repoRoot: string, runId: string, runtimeDirectory?: string) {
  const raw = runRecoveryStore(runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory, runId).read();
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid recovery proposal");
  const row = raw as Record<string, unknown>;
  if (row.schema !== "ChatRunRecovery@1" || row.runId !== runId ||
    typeof row.originDispatchId !== "string" || typeof row.preparedByDispatchId !== "string") throw new Error("Invalid recovery proposal identity");
  const decision = parseRunDecision(row.decision);
  if (decision.schemaVersion !== "RunDecision@1") throw new Error("Recovery requires a manual decision");
  const proposal = {schema: "ChatRunRecovery@1" as const, runId,
    originDispatchId: row.originDispatchId, preparedByDispatchId: row.preparedByDispatchId, decision};
  return {...proposal, revision: fingerprint(proposal)};
}

export function prepareChatRunRecovery(context: ChatWorkQueryContext, input: {runId: string; decision: unknown}) {
  const originDispatchId = requireChatRunOrigin(context, input.runId);
  const run = inspectStewardRunView(context.repoRoot, input.runId, context.runtimeDirectory, {inspectCurrentWorkspaceRevision: false});
  if (!run.intervention?.allowedActions.includes("decide")) throw new Error("Run has no settled manual recovery to prepare");
  const decision = parseRunDecision(input.decision);
  validateCallerRunDecision(context.repoRoot, input.runId, decision, context.runtimeDirectory);
  const proposal = {schema: "ChatRunRecovery@1" as const, runId: input.runId,
    originDispatchId, preparedByDispatchId: context.dispatchEventId!, decision};
  runRecoveryStore(runtimePaths(context.repoRoot, context.runtimeDirectory).runtimeDirectory, input.runId).write(proposal);
  return {status: "prepared", runId: input.runId, revision: fingerprint(proposal),
    next: "The original Chat Run card now shows the recovery proposal. Ask the Owner to review and confirm there. Do not submit it or ask the Owner to edit JSON."};
}

export function inspectChatRunRecovery(repoRoot: string, runId: string, runtimeDirectory?: string) {
  const proposal = readProposal(repoRoot, runId, runtimeDirectory);
  const request = inspectRecoveryRequest(repoRoot, runId, proposal !== null, runtimeDirectory);
  if (!proposal) return {proposal: null, request};
  const run = inspectStewardRunView(repoRoot, runId, runtimeDirectory, {inspectCurrentWorkspaceRevision: false});
  if (!run.intervention || run.projection.version !== proposal.decision.expectedRunVersion) return {proposal: null, request};
  const decision = proposal.decision;
  const targetRef = decision.action === "next_step" ? decision.nextStep.target : undefined;
  const target = targetRef?.kind === "agent"
    ? run.participants.find(p => p.principalId === targetRef.agentId)?.handle ?? targetRef.agentId
    : run.summary.steward.handle;
  return {proposal: {revision: proposal.revision, runVersion: decision.expectedRunVersion,
    action: decision.action, reason: decision.rationale, checkedAcceptance: decision.checkedAcceptance,
    effect: decision.action === "next_step"
      ? `@${target}: ${decision.nextStep.mandate.kind === "objective" ? decision.nextStep.mandate.objective : decision.nextStep.mandate.workflowRef}`
      : decision.action === "finish" ? `${decision.finish.outcome}: ${decision.finish.summary}` : "End this Run as needs_human",
    workspace: run.summary.workspace?.root ?? null}, request};
}

export function requestChatRunRecovery(repoRoot: string, runId: string, requestId: string, runtimeDirectory?: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) throw new Error("requestId must be 1-128 URL-safe characters");
  const run = inspectStewardRunView(repoRoot, runId, runtimeDirectory, {inspectCurrentWorkspaceRevision: false});
  if (!run.intervention?.allowedActions.includes("decide")) throw new Error("Run has no settled manual recovery to prepare");
  const origin = inspectChatRunOrigin(repoRoot, runId, runtimeDirectory);
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const database = openRuntimeDatabase(paths.database);
  const runtime = new RuntimeStore(database, {migrate:false});
  try {
    const governance = database.prepare(`SELECT revision FROM topic_governance topic
      JOIN json_each(topic.participants_json) participant
      WHERE topic.topic_id = ? AND topic.status = 'active'
      AND json_extract(participant.value, '$.agentId') = ?
      AND json_extract(participant.value, '$.status') = 'active'`).get(origin.topicId, origin.agentId) as {revision:number}|undefined;
    if (governance === undefined) throw new Error("Original Chat Agent is no longer active in this Topic");
    const key = `chat-run-recovery:${runId}:${requestId}`;
    const receipt = runtime.createChatActivation({topicId:origin.topicId,
      reason:"work_result", strategyId:"work-result", contextRevision:governance.revision,
      candidateAgentIds:[origin.agentId], sourceEventId:origin.dispatchEventId, idempotencyKey:key, turnBudget:1,
      conversationIntent:{schema:"ConversationIntentSnapshot@1",mode:"directed",governanceRevision:governance.revision,
        brief:`Prepare a recovery proposal for Run ${runId} at version ${run.projection.version}. Read get_run first, then call prepare_chat_run_recovery with a corrected decision. Preserve the original task, workspace, and authority. Do not continue, cancel, or recreate the Run; the Owner will confirm on the original card.`}
    });
    if (receipt.status === "duplicate" && receipt.event.source.externalId !== `chat-activation:${key}`) {
      throw new Error("Another Chat turn is active in this Topic; wait for it to finish before requesting recovery");
    }
    return {status:receipt.status, runId, activationEventId:receipt.event.eventId};
  } finally { runtime.close(); database.close(); }
}

function inspectRecoveryRequest(repoRoot: string, runId: string, proposalPrepared: boolean, runtimeDirectory?: string) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const prefix = `chat-activation:chat-run-recovery:${runId}:`;
    const activation = database.prepare(`SELECT event_id FROM events
      WHERE type = 'chat.activation' AND source_kind = 'handler'
      AND substr(source_external_id, 1, length(?)) = ?
      ORDER BY created_at DESC, event_id DESC LIMIT 1`).get(prefix, prefix) as {event_id:string}|undefined;
    if (activation === undefined) return null;
    const child = database.prepare(`SELECT event_id FROM events WHERE type = 'chat.dispatch'
      AND json_extract(payload_json, '$.sourceAttentionEventId') = ? ORDER BY created_at DESC, event_id DESC LIMIT 1`)
      .get(activation.event_id) as {event_id:string}|undefined;
    const executionEventId = child?.event_id ?? activation.event_id;
    const execution = database.prepare("SELECT status, last_error FROM executions WHERE event_id = ?")
      .get(executionEventId) as {status:string;last_error:string|null}|undefined;
    const missingDispatch = child === undefined && execution?.status === "succeeded";
    const missingProposal = child !== undefined && execution?.status === "succeeded" && !proposalPrepared;
    const state = execution?.status === "failed" || execution?.status === "cancelled" || missingDispatch || missingProposal ? "failed"
      : child !== undefined && execution?.status === "succeeded" ? "succeeded"
      : child !== undefined ? "running" : "queued";
    return {state, ...(missingDispatch ? {error:"responsible_agent_was_not_dispatched"}
      : missingProposal ? {error:"responsible_agent_finished_without_preparing_recovery"}
      : state === "failed" && execution?.last_error ? {error:execution.last_error} : {})};
  } finally { database.close(); }
}

export function confirmChatRunRecovery(repoRoot: string, runId: string, revision: string, runtimeDirectory?: string) {
  const proposal = readProposal(repoRoot, runId, runtimeDirectory);
  if (!proposal || proposal.revision !== revision) throw new Error("Recovery proposal changed; review the current card before confirming");
  return submitCallerRunDecision(repoRoot, runId, {requestId: `chat-recovery:${revision}`, decision: proposal.decision, requireManualFallback: true}, runtimeDirectory);
}
