import type { DatabaseSync } from "node:sqlite";
import type { ChatMessageEvent } from "../../core/event/model.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import { supportsStewardClient } from "../../modules/steward/steward-policy.js";
import { chatRunOriginSql, chatRunTaskSourceSql, chatRunTaskSpan, chatTasksOverlap, type ChatTaskSpan } from "./work-origin.js";

/** The accepted Run is the durable claim; no second mutable task lifecycle. */
export function chatTaskClaims(database: DatabaseSync, messageId: string) {
  return taskClaims(database, "source.event_id", messageId);
}

/** Dispatch identity is independent of the Owner message selected for task deduplication. */
export function chatDispatchTaskClaims(database: DatabaseSync, dispatchId: string) {
  return taskClaims(database, "dispatch.event_id", dispatchId);
}

function taskClaims(database: DatabaseSync, key: "source.event_id" | "dispatch.event_id", id: string) {
  const rows = database.prepare(`SELECT run.run_id AS runId, dispatch.event_id AS dispatchEventId,
    dispatch.agent_id AS agentId, run.status, run.owner_request_id AS requestId,
    source.event_id AS taskSourceMessageEventId, json_extract(source.payload_json, '$.body') AS body
    FROM agent_runs run JOIN events dispatch ON dispatch.type = 'chat.dispatch' AND ${chatRunOriginSql("dispatch")}
    JOIN events source ON source.event_id = (${chatRunTaskSourceSql("dispatch")})
    WHERE ${key} = ? ORDER BY run.created_at, run.run_id`).all(id) as unknown as {
      runId:string; dispatchEventId:string; agentId:string; status:string; requestId:string; body:string; taskSourceMessageEventId:string
    }[];
  return rows.map(({body, requestId, ...row}) => {
    const task = chatRunTaskSpan(requestId);
    return {...row, ...(task ? {task, taskQuote:body.slice(task.start,task.end)} : {})};
  });
}
export function existingChatTask(database: DatabaseSync, messageId: string, task?: ChatTaskSpan) {
  return chatTaskClaims(database,messageId).find(claim => chatTasksOverlap(claim.task,task));
}

export function chatTaskCandidates(database: DatabaseSync, source: ChatMessageEvent, agents: readonly LocalAgent[]) {
  const rows = database.prepare(`SELECT DISTINCT d.agent_id FROM events d JOIN topic_governance t
    ON t.topic_id = json_extract(d.payload_json, '$.topicId') JOIN json_each(t.participants_json) p
    WHERE d.type = 'chat.dispatch' AND json_extract(d.payload_json, '$.sourceMessageEventId') = ?
    AND t.status = 'active' AND json_extract(p.value, '$.agentId') = d.agent_id
    AND json_extract(p.value, '$.status') = 'active'`).all(source.eventId) as {agent_id:string}[];
  const dispatched = new Set(rows.map(row=>row.agent_id));
  const candidates = agents.filter(agent=>agent.status === "active" && dispatched.has(agent.principalId));
  const explicit = source.targets?.map(target=>target.principalId) ?? [];
  const mentions = [...source.body.normalize("NFKC").matchAll(/(?:^|[^\p{L}\p{N}_-])@([\p{L}\p{N}_-]+)/gu)].map(match=>match[1]!.toLocaleLowerCase());
  const named = explicit.length ? candidates.filter(agent=>explicit.includes(agent.principalId))
    : candidates.filter(agent=>mentions.includes(agent.handle.toLocaleLowerCase()));
  const pool = named.length ? named : candidates;
  const load = (agent: LocalAgent) => Number((database.prepare(`SELECT count(*) AS n FROM executions e JOIN events v ON v.event_id = e.event_id
    WHERE v.agent_id = ? AND e.status IN ('queued','running','retry_wait')
    AND (v.type != 'chat.dispatch' OR json_extract(v.payload_json, '$.sourceMessageEventId') != ?)`)
    .get(agent.principalId,source.eventId) as {n:number}).n);
  const supported = pool.filter(agent=>supportsStewardClient(agent.client));
  supported.sort((a,b)=>load(a)-load(b) || a.handle.localeCompare(b.handle) || a.principalId.localeCompare(b.principalId));
  const joined = new Set((database.prepare(`SELECT json_extract(p.value, '$.agentId') AS agent_id FROM topic_governance t JOIN json_each(t.participants_json) p
    WHERE t.topic_id = ? AND t.status = 'active' AND json_extract(p.value, '$.status') = 'active'`).all(source.topicId) as {agent_id:string}[]).map(row=>row.agent_id));
  return {owner:supported[0], candidates:supported, workers: agents.filter(agent=>agent.status === "active" && joined.has(agent.principalId) && supportsStewardClient(agent.client))};
}
