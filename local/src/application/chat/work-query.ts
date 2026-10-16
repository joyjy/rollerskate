import { agentRunReturnView } from "./callback-query.js";
import type { DatabaseSync } from "node:sqlite";
import { chatRunOriginSql } from "./work-origin.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { RunAdmissionStore } from "../../infrastructure/files/run-admission-store.js";
import { inspectStewardWork } from "../steward/work-query.js";
import { isDeterministicRunId } from "../../modules/run/intent.js";
import { inspectRun } from "../run/query.js";
import { redact } from "../../integrations/activity/provider-source.js";

export interface ChatWorkQueryContext {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  // Supplied by the Host invocation, never by tool arguments.
  readonly dispatchEventId?: string;
}
interface WorkOrigin {
  event_id: string; created_at: string; source_message_id: string;
  agent_id: string; topic_id: string; session_id: string | null; run_id: string;
}

export interface ChatRunOrigin {
  readonly dispatchEventId: string;
  readonly agentId: string;
  readonly topicId: string;
  readonly sessionId: string;
}

function workOrigins(context: ChatWorkQueryContext, database: DatabaseSync,
  filter: {agentId:string;topicId:string} | {messageIds:readonly string[]}, runId?:string): WorkOrigin[] {
  const predicate = "messageIds" in filter
    ? `json_extract(work.payload_json, '$.sourceMessageEventId') IN (${filter.messageIds.map(()=>"?").join(",")})`
    : "work.agent_id = ? AND json_extract(work.payload_json, '$.topicId') = ?";
  const bindings = "messageIds" in filter ? filter.messageIds : [filter.agentId,filter.topicId];
  const dispatches = database.prepare(`SELECT work.event_id, work.created_at, work.agent_id,
    json_extract(work.payload_json, '$.topicId') topic_id,
    json_extract(work.payload_json, '$.sourceMessageEventId') source_message_id,
    COALESCE(json_extract(execution.receipt_json, '$.sessionId'), work.session_id) session_id
    FROM events work JOIN executions execution ON execution.event_id = work.event_id
    WHERE work.type = 'chat.dispatch' AND ${predicate}`).all(...bindings) as unknown as Omit<WorkOrigin, "run_id">[];
  const agentRuns = database.prepare(`SELECT work.event_id, run.run_id FROM events work
    JOIN agent_runs run ON ${chatRunOriginSql("work")} WHERE work.type = 'chat.dispatch' AND ${predicate}${runId === undefined ? "" : " AND run.run_id = ?"}`).all(...bindings,...(runId === undefined ? [] : [runId])) as unknown as {event_id:string;run_id:string}[];
  const byDispatch = new Map(dispatches.map(row => [row.event_id, row]));
  const store = new RunAdmissionStore(runtimePaths(context.repoRoot, context.runtimeDirectory).runtimeDirectory);
  const admissions = runId === undefined ? store.list() : isDeterministicRunId(runId) ? [store.read(runId)] : [];
  const refs = [...agentRuns, ...admissions.flatMap(admission => {
    const destination = admission.intent.resultDestinationRef;
    return destination?.startsWith("rs-chat:") ? [{event_id:destination.slice("rs-chat:".length),run_id:admission.runId}] : [];
  })];
  return refs.flatMap(ref => {
    const dispatch = byDispatch.get(ref.event_id);
    return dispatch === undefined ? [] : [{...dispatch, run_id:ref.run_id}];
  }).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.event_id.localeCompare(a.event_id) || b.run_id.localeCompare(a.run_id));
}

function currentScope(context: ChatWorkQueryContext, database: DatabaseSync) {
  const runtime = new RuntimeStore(database, {migrate:false});
  if (context.dispatchEventId === undefined) throw new Error("Chat work scope is unavailable");
  const dispatch = runtime.event(context.dispatchEventId);
  if (dispatch?.type !== "chat.dispatch" || runtime.executionForEvent(dispatch.eventId)?.status !== "running") {
    throw new Error("Chat work scope is unavailable");
  }
  const session = runtime.currentLocalAgentSession(dispatch.agentId);
  const sessionId = dispatch.sessionId ?? session?.sessionId;
  const eligible = database.prepare(`SELECT 1 FROM agents agent
    JOIN topic_governance topic ON topic.topic_id = ? JOIN json_each(topic.participants_json) participant
    WHERE agent.principal_id = ? AND agent.status = 'active' AND topic.status = 'active'
    AND json_extract(participant.value, '$.agentId') = agent.principal_id
    AND json_extract(participant.value, '$.status') = 'active'`).get(dispatch.topicId, dispatch.agentId);
  if (eligible === undefined || (sessionId !== undefined && session?.sessionId !== sessionId)) throw new Error("Chat work scope is no longer active");
  return {dispatch, sessionId};
}

function activeDispatch(context: ChatWorkQueryContext, database: DatabaseSync) {
  const runtime = new RuntimeStore(database, {migrate:false});
  if (context.dispatchEventId === undefined) throw new Error("Chat work scope is unavailable");
  const dispatch = runtime.event(context.dispatchEventId);
  if (dispatch?.type !== "chat.dispatch" || runtime.executionForEvent(dispatch.eventId)?.status !== "running") {
    throw new Error("Chat work scope is unavailable");
  }
  const eligible = database.prepare(`SELECT 1 FROM agents agent
    JOIN topic_governance topic ON topic.topic_id = ? JOIN json_each(topic.participants_json) participant
    WHERE agent.principal_id = ? AND agent.status = 'active' AND topic.status = 'active'
    AND json_extract(participant.value, '$.agentId') = agent.principal_id
    AND json_extract(participant.value, '$.status') = 'active'`).get(dispatch.topicId, dispatch.agentId);
  if (eligible === undefined) throw new Error("Chat work scope is no longer active");
  return {runtime, dispatch};
}

function recoveryOrigin(context: ChatWorkQueryContext, database: DatabaseSync, runId: string) {
  const {runtime, dispatch} = activeDispatch(context, database);
  const activation = runtime.event(dispatch.sourceAttentionEventId);
  const prefix = `chat-activation:chat-run-recovery:${runId}:`;
  if (activation?.type !== "chat.activation" || activation.reason !== "work_result" ||
    activation.strategyId !== "work-result" ||
    (activation.sessionId !== undefined && activation.sessionId !== dispatch.sessionId) ||
    activation.source.externalId === undefined || !activation.source.externalId.startsWith(prefix) ||
    activation.sourceEventId === undefined || activation.candidateAgentIds.length !== 1 ||
    activation.candidateAgentIds[0] !== dispatch.agentId) return undefined;
  const origin = chatRunOrigin(database, runId);
  if (origin === undefined || origin.dispatchEventId !== activation.sourceEventId ||
    origin.agentId !== dispatch.agentId || origin.topicId !== dispatch.topicId) return undefined;
  return origin;
}

function chatRunOrigin(database: DatabaseSync, runId: string): ChatRunOrigin | undefined {
  const row = database.prepare(`SELECT work.event_id dispatch_event_id, work.agent_id,
    json_extract(work.payload_json, '$.topicId') topic_id,
    COALESCE(json_extract(execution.receipt_json, '$.sessionId'), work.session_id) session_id
    FROM agent_runs run JOIN events work ON ${chatRunOriginSql("work")}
    JOIN executions execution ON execution.event_id = work.event_id
    WHERE run.run_id = ? AND work.type = 'chat.dispatch'
    ORDER BY work.created_at DESC, work.event_id DESC LIMIT 1`).get(runId) as {
      dispatch_event_id:string; agent_id:string; topic_id:string; session_id:string|null;
    } | undefined;
  return row?.session_id === null ? undefined : row === undefined ? undefined : {
    dispatchEventId:row.dispatch_event_id, agentId:row.agent_id, topicId:row.topic_id, sessionId:row.session_id
  };
}
function scopedOrigins(context: ChatWorkQueryContext, database: DatabaseSync, runId?:string) {
  const scope = currentScope(context, database);
  return {...scope, rows: workOrigins(context, database, {agentId:scope.dispatch.agentId,topicId:scope.dispatch.topicId},runId).filter(row =>
    row.agent_id === scope.dispatch.agentId && row.topic_id === scope.dispatch.topicId &&
    (row.event_id === scope.dispatch.eventId || (scope.sessionId !== undefined && row.session_id === scope.sessionId)))};
}

export function requireChatRunOrigin(context: ChatWorkQueryContext, runId: string) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(context.repoRoot, context.runtimeDirectory).database);
  try {
    let row: WorkOrigin | undefined;
    try { row = scopedOrigins(context, database, runId).rows.find(row => row.run_id === runId); }
    catch (error) {
      const recovery = recoveryOrigin(context, database, runId);
      if (recovery !== undefined) return recovery.dispatchEventId;
      throw error;
    }
    if (row === undefined) {
      const recovery = recoveryOrigin(context, database, runId);
      if (recovery !== undefined) return recovery.dispatchEventId;
      throw new Error("Chat Run is outside the current scope");
    }
    return row.event_id;
  } finally { database.close(); }
}

export function inspectChatRunOrigin(repoRoot: string, runId: string, runtimeDirectory?: string): ChatRunOrigin {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const origin = chatRunOrigin(database, runId);
    if (origin === undefined) throw new Error("Run has no Chat Session origin");
    return origin;
  } finally { database.close(); }
}

export function deterministicChatWork(view: Extract<ReturnType<typeof inspectRun>, {kind:string}>) {
  const terminal = ["succeeded", "failed", "cancelled"].includes(view.status);
  return {
    kind:view.kind, runId:view.runId, label:redact(view.title).slice(0,512),
    sourceId:view.admission.sourceId, status:view.status, terminal,
    state:view.status === "unknown" || view.status === "attention_required" ? "needs_human" as const : terminal ? "terminal" as const : "started" as const,
    result:view.result, deliveryStatus:view.deliveryStatus,
    returnState:view.chatCallbacks?.[0]?.returnState ?? null,
    detail:{tool:"get_run" as const,runId:view.runId}, updatedAt:view.updatedAt
  };
}
function workView(context: ChatWorkQueryContext, database: DatabaseSync, row: WorkOrigin) {
  if (isDeterministicRunId(row.run_id)) {
    const view = inspectRun(context.repoRoot, row.run_id, context.runtimeDirectory);
    if ("kind" in view) return deterministicChatWork(view);
  }
  const work = inspectStewardWork(context.repoRoot,row.run_id,context.runtimeDirectory,database);
  return {...work,returnState:agentRunReturnView(database,row.event_id,work)};
}

export function listChatWork(context: ChatWorkQueryContext,
  options: {readonly beforeDispatchEventId?:string; readonly beforeRunId?:string; readonly limit:number}) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(context.repoRoot, context.runtimeDirectory).database);
  try {
    const {dispatch,sessionId,rows} = scopedOrigins(context,database);
    if (options.beforeRunId !== undefined && options.beforeDispatchEventId === undefined) throw new Error("Chat work cursor requires its dispatch");
    let remaining = rows;
    if (options.beforeDispatchEventId !== undefined) {
      const index = rows.findIndex(row => row.event_id === options.beforeDispatchEventId &&
        (options.beforeRunId === undefined || row.run_id === options.beforeRunId));
      if (index < 0) throw new Error("Chat work cursor is outside the current scope");
      remaining = options.beforeRunId === undefined ? rows.slice(index).filter(row => row.event_id !== options.beforeDispatchEventId) : rows.slice(index+1);
    }
    const selected = remaining.slice(0,options.limit);
    return {schemaVersion:"ChatWorkPage@1",scope:{topicId:dispatch.topicId,agentId:dispatch.agentId,sessionId:sessionId ?? null},
      items:selected.map(row => ({sourceMessageEventId:row.source_message_id,dispatchEventId:row.event_id,
        responsibleAgentId:row.agent_id,originatingSessionId:row.session_id ?? undefined,...workView(context,database,row)})),
      hasEarlier:remaining.length > options.limit,
      ...(remaining.length <= options.limit ? {} : {beforeDispatchEventId:selected.at(-1)!.event_id,beforeRunId:selected.at(-1)!.run_id})};
  } finally {database.close();}
}

export function chatWorkForMessages(context: ChatWorkQueryContext & {readonly database:DatabaseSync}, messageIds:readonly string[]) {
  if (!messageIds.length) return [];
  const ids = new Set(messageIds);
  return workOrigins(context,context.database,{messageIds}).filter(row => ids.has(row.source_message_id)).reverse().map(row => ({
    sourceMessageEventId:row.source_message_id,dispatchEventId:row.event_id,...workView(context,context.database,row)}));
}

export type ChatWorkView = ReturnType<typeof workView>;
