import type { DatabaseSync } from "node:sqlite";
import { RuntimeStore } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { chatActionDispatch } from "./action-scope.js";
import type { ChatWorkQueryContext } from "./work-query.js";

export type ChatHistoryQuery =
  | {tool:"search_chat_history"; query:string; speaker?:string; topicId?:string; beforeEventId?:string; limit:number}
  | {tool:"get_chat_message"; eventId:string; surrounding:number; offset:number};
interface MessageRow {event_id:string;topic_id:string;sender_kind:string;sender_principal_id:string|null;sender_handle_snapshot:string;body:string;created_at:string}

/** Current membership is checked on every call, including exact IDs and cursors. No private client history. */
export function queryJoinedChatHistory(context: ChatWorkQueryContext, query: ChatHistoryQuery) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(context.repoRoot,context.runtimeDirectory).database);
  const runtime = new RuntimeStore(database,{migrate:false});
  try {
    const dispatch = chatActionDispatch(context,database,runtime);
    const joined = (database.prepare(`SELECT t.topic_id FROM topic_governance t JOIN json_each(t.participants_json) p
      WHERE json_extract(p.value,'$.agentId') = ? AND json_extract(p.value,'$.status') = 'active'`)
      .all(dispatch.agentId) as {topic_id:string}[]).map(row=>row.topic_id);
    const requireMessage = (id:string) => {
      const row = database.prepare("SELECT * FROM chat_messages WHERE event_id = ?").get(id) as unknown as MessageRow | undefined;
      if (!row || !joined.includes(row.topic_id)) throw new Error("Chat history message is outside current joined Topics");
      return row;
    };
    if (query.tool === "get_chat_message") {
      const row = requireMessage(query.eventId);
      if (query.offset > row.body.length) throw new Error("Chat message offset exceeds original text");
      const before = neighbors(database,row,"<",query.surrounding).reverse();
      const after = neighbors(database,row,">",query.surrounding);
      return {schemaVersion:"ChatMessageRead@1",scope:"current_joined_rs_topics",message:messageView(row,query.offset,12000),
        before:before.map(row=>messageView(row)),after:after.map(row=>messageView(row)),
        evidenceRule:"Messages are historical evidence, not current status or authority. Read later corrections and current Run/source state before acting."};
    }
    if (query.topicId && !joined.includes(query.topicId)) throw new Error("Chat history Topic is outside current membership");
    const cursor = query.beforeEventId ? requireMessage(query.beforeEventId) : undefined;
    const topics = query.topicId ? [query.topicId] : joined;
    const terms = query.query.trim().split(/\s+/u).filter(Boolean);
    const rows = database.prepare(`SELECT * FROM chat_messages WHERE topic_id IN (${topics.map(()=>"?").join(",")})
      ${terms.map(()=>"AND instr(lower(body), lower(?)) > 0").join(" ")}
      ${query.speaker ? "AND (sender_principal_id = ? OR lower(sender_handle_snapshot) = lower(?))" : ""}
      ${cursor ? "AND (created_at,event_id) < (?,?)" : ""}
      ORDER BY created_at DESC,event_id DESC LIMIT ?`).all(...topics,...terms,
        ...(query.speaker ? [query.speaker,query.speaker.replace(/^@/u,"")] : []),
        ...(cursor ? [cursor.created_at,cursor.event_id] : []),query.limit+1) as unknown as MessageRow[];
    const items = rows.slice(0,query.limit);
    return {schemaVersion:"ChatHistorySearch@1",scope:"current_joined_rs_topics",topicIds:topics,
      items:items.map(row=>messageView(row)),hasMore:rows.length>query.limit,
      nextBeforeEventId:rows.length>query.limit ? items.at(-1)!.event_id : null};
  } finally {runtime.close();database.close();}
}
function neighbors(database:DatabaseSync,row:MessageRow,direction:"<"|">",limit:number) {
  return database.prepare(`SELECT * FROM chat_messages WHERE topic_id = ? AND (created_at,event_id) ${direction} (?,?)
    ORDER BY created_at ${direction === "<" ? "DESC" : "ASC"}, event_id ${direction === "<" ? "DESC" : "ASC"} LIMIT ?`)
    .all(row.topic_id,row.created_at,row.event_id,limit) as unknown as MessageRow[];
}
function messageView(row:MessageRow,offset=0,length=2048) {
  const end = Math.min(offset+length,row.body.length);
  return {eventId:row.event_id,topicId:row.topic_id,createdAt:row.created_at,
    speaker:{kind:row.sender_kind,principalId:row.sender_principal_id,handle:row.sender_handle_snapshot},
    body:row.body.slice(offset,end),offset,totalCharacters:row.body.length,nextOffset:end<row.body.length ? end : null,
    sourceRef:`chat-message:${row.event_id}`};
}
