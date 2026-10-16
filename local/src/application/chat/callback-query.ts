import { chatRunOriginSql } from "./work-origin.js";
import type { DatabaseSync } from "node:sqlite";
import { RuntimeStore } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { parseDeterministicApplicationActionReceipt } from "../../modules/proactive/target.js";
import { redact } from "../../integrations/activity/provider-source.js";
import { CHAT_CALLBACK_ACTION, chatReturnState, parseChatCallbackInput } from "./callback.js";
import { chatActionDispatch } from "./action-scope.js";
import type { ChatWorkQueryContext } from "./work-query.js";
import type { StewardWorkView } from "../steward/work-query.js";

/** Project only explicit resumable origins; old proposals never acquire callback authority. */
export function agentRunReturnView(database: DatabaseSync, dispatchEventId: string, work: StewardWorkView) {
  const origin = database.prepare(`SELECT 1 FROM agent_runs run JOIN events dispatch ON dispatch.event_id = ?
    WHERE run.run_id = ? AND ${chatRunOriginSql("dispatch", true)}`)
    .get(dispatchEventId, work.runId);
  if (!origin) return {status: "not_requested"} as const;
  if (!work.terminal && work.state !== "needs_human") {
    return {status: "awaiting_result"} as const;
  }
  const runtime = new RuntimeStore(database, {migrate: false});
  return chatReturnState(database, runtime, dispatchEventId, `chat-work-return:${work.runId}:${work.version}`);
}

export function callbackViews(database: DatabaseSync, sourceId: string) {
  const rows = database.prepare(`SELECT receipt_json FROM deterministic_action_receipts
    WHERE source_id = ? AND action_ref = ? ORDER BY created_at DESC, receipt_id DESC LIMIT 20`)
    .all(sourceId, CHAT_CALLBACK_ACTION) as {receipt_json: string}[];
  const runtime = new RuntimeStore(database, {migrate: false});
  return rows.map(row => callbackView(database, runtime, row.receipt_json));
}

function callbackView(database: DatabaseSync, runtime: RuntimeStore, encoded: string) {
  const receipt = parseDeterministicApplicationActionReceipt(JSON.parse(encoded));
  if (receipt.actionRef !== CHAT_CALLBACK_ACTION) throw new Error("Not a Chat callback receipt");
  if (receipt.status !== "succeeded") return {receipt, returnState: {status: "failed", reason: receipt.error ?? "action_failed"}};
  const output = receipt.output as {dispatchEventId: string; title: string};
  const target = parseChatCallbackInput({dispatchEventId: output.dispatchEventId, title: output.title});
  return {receipt, returnState: chatReturnState(database, runtime, target.dispatchEventId, `chat-callback-return:${receipt.receiptId}`)};
}

export function readChatCallback(context: ChatWorkQueryContext, receiptId: string) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(context.repoRoot, context.runtimeDirectory).database);
  const runtime = new RuntimeStore(database, {migrate: false});
  try {
    const dispatch = chatActionDispatch(context, database, runtime);
    const row = database.prepare("SELECT receipt_json FROM deterministic_action_receipts WHERE receipt_id = ? AND action_ref = ?")
      .get(receiptId, CHAT_CALLBACK_ACTION) as {receipt_json: string} | undefined;
    if (!row) throw new Error("Chat callback receipt not found");
    const view = callbackView(database, runtime, row.receipt_json);
    const output = view.receipt.output as {dispatchEventId?: string} | undefined;
    const origin = output?.dispatchEventId ? runtime.event(output.dispatchEventId) : undefined;
    if (origin?.type !== "chat.dispatch" || origin.agentId !== dispatch.agentId || origin.topicId !== dispatch.topicId) {
      throw new Error("Chat callback is outside this responsible Agent and Topic");
    }
    const originSession = runtime.chatDecisionReceipt(origin.eventId)?.sessionId ?? origin.sessionId;
    const currentSession = dispatch.sessionId ?? runtime.currentLocalAgentSession(dispatch.agentId)?.sessionId;
    if (originSession === undefined || originSession !== currentSession) {
      throw new Error("Chat callback is outside this responsible Session");
    }
    return JSON.parse(JSON.stringify(view, (_key, value: unknown) => typeof value === "string" ? redact(value, Infinity) : value)) as unknown;
  } finally {runtime.close(); database.close();}
}
