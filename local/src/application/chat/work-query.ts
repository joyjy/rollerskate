import type { DatabaseSync } from "node:sqlite";
import { chatRunOriginSql } from "./work-origin.js";
import { parseChatDecisionReceipt } from "../../core/runtime/store/codec.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { inspectStewardWork } from "../steward/work-query.js";

export interface ChatWorkQueryContext {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  // Supplied by the Host invocation, never by tool arguments.
  readonly dispatchEventId?: string;
}

export function listChatWork(
  context: ChatWorkQueryContext,
  options: { readonly beforeDispatchEventId?: string; readonly limit: number }
) {
  if (context.dispatchEventId === undefined) throw new Error("Chat work scope is unavailable");
  const database = openRuntimeDatabaseReadOnly(
    runtimePaths(context.repoRoot, context.runtimeDirectory).database
  );
  const runtime = new RuntimeStore(database, { migrate: false });
  try {
    const dispatch = runtime.event(context.dispatchEventId);
    if (dispatch?.type !== "chat.dispatch" ||
      runtime.executionForEvent(dispatch.eventId)?.status !== "running") {
      throw new Error("Chat work scope is unavailable");
    }
    const session = runtime.currentLocalAgentSession(dispatch.agentId);
    const sessionId = dispatch.sessionId ?? session?.sessionId;
    const eligible = database.prepare(`
      SELECT 1 FROM agents AS agent
      JOIN topic_governance AS topic ON topic.topic_id = ?
      JOIN json_each(topic.participants_json) AS participant
      WHERE agent.principal_id = ? AND agent.status = 'active'
        AND topic.status = 'active'
        AND json_extract(participant.value, '$.agentId') = agent.principal_id
        AND json_extract(participant.value, '$.status') = 'active'
    `).get(dispatch.topicId, dispatch.agentId);
    if (eligible === undefined || (sessionId !== undefined && session?.sessionId !== sessionId)) {
      throw new Error("Chat work scope is no longer active");
    }
    const before = options.beforeDispatchEventId === undefined
      ? undefined : runtime.audit(options.beforeDispatchEventId);
    const beforeReceipt = before?.execution === undefined ? undefined : parseChatDecisionReceipt(
      runtime.executionReceiptJson(before.execution.executionId)
    );
    if (options.beforeDispatchEventId !== undefined &&
      (before?.event.type !== "chat.dispatch" || before.event.agentId !== dispatch.agentId ||
        before.event.topicId !== dispatch.topicId || (beforeReceipt?.sessionId ?? before.event.sessionId) !== sessionId)) {
      throw new Error("Chat work cursor is outside the current scope");
    }
    const rows = sessionId === undefined ? [] : database.prepare(`
      SELECT work.event_id, work.created_at,
        json_extract(work.payload_json, '$.sourceMessageEventId') AS source_message_id,
        run.run_id
      FROM events AS work
      JOIN executions AS execution ON execution.event_id = work.event_id
      JOIN agent_runs AS run ON ${chatRunOriginSql("work")}
      WHERE work.type = 'chat.dispatch' AND work.agent_id = ?
        AND json_extract(work.payload_json, '$.topicId') = ? AND COALESCE(json_extract(execution.receipt_json, '$.sessionId'), work.session_id) = ?
        AND (? IS NULL OR (work.created_at, work.event_id) < (?, ?))
      ORDER BY work.created_at DESC, work.event_id DESC LIMIT ?
    `).all(dispatch.agentId, dispatch.topicId, sessionId,
      before?.event.createdAt ?? null, before?.event.createdAt ?? null,
      options.beforeDispatchEventId ?? null, options.limit + 1) as unknown as readonly {
        event_id: string; source_message_id: string; run_id: string;
      }[];
    const selected = rows.slice(0, options.limit);
    return {
      schemaVersion: "ChatWorkPage@1",
      scope: { topicId: dispatch.topicId, agentId: dispatch.agentId, sessionId: sessionId ?? null },
      items: selected.map((row) => ({
        sourceMessageEventId: row.source_message_id,
        dispatchEventId: row.event_id,
        responsibleAgentId: dispatch.agentId,
        originatingSessionId: sessionId,
        ...inspectStewardWork(context.repoRoot, row.run_id, context.runtimeDirectory, database)
      })),
      hasEarlier: rows.length > options.limit,
      ...(rows.length <= options.limit ? {} : {
        beforeDispatchEventId: selected.at(-1)!.event_id
      })
    };
  } finally {
    runtime.close();
    database.close();
  }
}

export function chatWorkForMessages(context: ChatWorkQueryContext & { readonly database: DatabaseSync }, messageIds: readonly string[]) {
  if (messageIds.length === 0) return [];
  const rows = context.database.prepare(`SELECT work.event_id,
    json_extract(work.payload_json, '$.sourceMessageEventId') source_message_id, run.run_id
    FROM events work JOIN agent_runs run ON ${chatRunOriginSql("work")}
    WHERE work.type = 'chat.dispatch' AND json_extract(work.payload_json, '$.sourceMessageEventId')
      IN (${messageIds.map(() => "?").join(",")}) ORDER BY work.created_at, work.event_id`).all(...messageIds) as unknown as {
      event_id: string; source_message_id: string; run_id: string;
    }[];
  return rows.map(row => ({sourceMessageEventId: row.source_message_id, dispatchEventId: row.event_id,
    ...inspectStewardWork(context.repoRoot, row.run_id, context.runtimeDirectory, context.database)}));
}
