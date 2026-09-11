import type { RuntimeStore } from "../../core/runtime/store.js";
import type { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { isTerminal, type AgentRunProjection } from "../../modules/steward/state-machine.js";
import { stewardOrchestratorContinuationPrompt } from "./orchestrator-retry.js";

// The Run owns suspension; the immutable decision and answer Event own history.
// No separate pending-request lifecycle or replay of a completed Worker.
export function runHumanQuestion(run: AgentRunProjection, runs: AgentRunStore, runtime: RuntimeStore,
  questionId?: string, at = new Date().toISOString()) {
  const record = runs.decisions(run.runId,questionId === undefined ? 1 : 1000).find(item =>
    item.receipt.schemaVersion === "AgentRunDecisionReceipt@3" &&
    (questionId === undefined || item.receipt.questionId === questionId));
  if (record?.decision.action !== "ask_human" || record.receipt.schemaVersion !== "AgentRunDecisionReceipt@3") return null;
  const question = record.receipt;
  const answerPrefix = `agent-run:${run.runId}:human-answer:${question.questionId}:`;
  const answerEvent = runtime.eventsForRoot(run.rootEventId).find(event => event.type === "agent.request" && event.source.externalId?.startsWith(answerPrefix));
  const expiresAt = run.deadlineAt ?? new Date(Date.parse(question.acceptedAt)+86_400_000).toISOString();
  const status = answerEvent !== undefined ? "answered" as const
    : isTerminal(run.status) ? "closed" as const
    : Date.parse(at) >= Date.parse(expiresAt) ? "expired" as const
    : run.status === "awaiting_orchestrator" && run.version === question.resultingRunVersion && run.activeExecutionId === undefined
      ? "pending" as const : "superseded" as const;
  return {questionId:question.questionId,question:record.decision.question,runVersion:question.resultingRunVersion,
    status,expiresAt,...(answerEvent === undefined ? {} : {answerEventId:answerEvent.eventId})};
}

export function answerRunHumanInTransaction(input: {
  readonly runtime: RuntimeStore; readonly runs: AgentRunStore; readonly run: AgentRunProjection;
  readonly questionId:string; readonly expectedVersion:number;
  readonly sourceMessageEventId:string; readonly at:string;
}) {
  const {runtime,runs,run,at} = input;
  const ownerMessage = runtime.event(input.sourceMessageEventId);
  if (ownerMessage?.type !== "chat.message" || ownerMessage.sender.kind !== "owner" ||
    ownerMessage.sender.principalId !== run.orchestratorBinding?.callerRef.principalId) throw new Error("Run answer requires its admitted Owner message");
  const answer = ownerMessage.body;
  const question = runHumanQuestion(run,runs,runtime,input.questionId,at);
  if (question === null) throw new Error("Run question is unavailable");
  if (question.status === "answered") return {status:"already_answered",runId:run.runId,questionId:question.questionId,eventId:question.answerEventId};
  if (question.status !== "pending") throw new Error(`Run question is ${question.status}`);
  if (input.expectedVersion !== question.runVersion || run.version !== input.expectedVersion) throw new Error("Run question version changed");
  if (answer.trim().length === 0 || Buffer.byteLength(answer,"utf8") > 16_384) throw new Error("Owner answer must fit within 16 KiB");
  const result = runtime.event(question.questionId);
  const request = result?.causality.parentEventId === undefined ? undefined : runtime.event(result.causality.parentEventId);
  const binding = run.orchestratorBinding;
  if (result?.type !== "agent.result" || result.outcome !== "succeeded" ||
    runtime.executionForEvent(result.eventId)?.status !== "succeeded" || request?.type !== "agent.request" ||
    binding?.schemaVersion !== "OrchestratorBinding@3" || (binding.decisionContractId !== "run-decision@5" && binding.decisionContractId !== "run-decision@6") ||
    request.agentId !== binding.orchestratorRef.agentId || request.runContext?.runId !== run.runId ||
    request.runContext.cycleId !== run.activeCycleId) throw new Error("Human answer source is not the settled Run Orchestrator");
  runs.requireActiveAgent(request.agentId);
  const sessionId = result.sessionId;
  const session = sessionId === undefined ? undefined : runtime.session(sessionId);
  if (session === undefined || session.runId !== run.runId || session.agentId !== request.agentId || !runtime.sessionIsIdle(session.sessionId)) {
    throw new Error("Original Run Orchestrator Session is unavailable or busy");
  }
  const prompt = [stewardOrchestratorContinuationPrompt(runs,{...run,version:run.version+1}),
    "The Owner answered the pending question. Continue from the preserved checkpoint and state; do not replay completed Workers.",
    "This answer supplies a choice or information within existing authority, not permission to expand tools, workspace, network, participants or budget.",
    JSON.stringify({schema:"RunHumanAnswer@1",questionId:question.questionId,question:question.question,
      sourceMessageEventId:input.sourceMessageEventId,answer})].join("\n");
  const admission = runtime.appendEventInTransaction({type:"agent.request",agentId:request.agentId,sessionId:session.sessionId,
    source:{kind:"handler",externalId:`agent-run:${run.runId}:human-answer:${question.questionId}:${input.sourceMessageEventId}`},
    prompt,runContext:request.runContext,parent:{eventId:result.eventId,rootEventId:run.rootEventId,hop:result.causality.hop},
    maxAttempts:1,createdAt:at});
  if (admission.status !== "accepted") throw new Error("Unexpected duplicate human answer admission");
  const resumed = runs.resumeHumanAnswerInTransaction(run.runId,run.version,at);
  return {status:"accepted",runId:run.runId,questionId:question.questionId,eventId:admission.event.eventId,version:resumed.version};
}
