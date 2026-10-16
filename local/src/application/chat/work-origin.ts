/** A task is an exact, unique span of the Owner instruction, never a replacement mandate. */
export interface ChatTaskSpan { readonly start: number; readonly end: number }
export function chatTaskSpan(body: string, quote?: string): ChatTaskSpan | undefined {
  if (quote === undefined) return undefined;
  if (quote.trim() === "" || quote.length > 4096) throw new Error("taskQuote must describe one task in at most 4096 characters");
  const start = body.indexOf(quote);
  if (start < 0 || body.indexOf(quote, start + 1) !== -1) throw new Error("taskQuote must occur exactly once in the Owner instruction");
  return {start, end: start + quote.length};
}
export function chatRunTaskSpan(requestId: string): ChatTaskSpan | undefined {
  const match = /:task-v1:(\d+):(\d+)$/u.exec(requestId);
  if (!match) return undefined;
  const start = Number(match[1]), end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error("Malformed Chat task origin");
  return {start,end};
}
export function chatTasksOverlap(left?: ChatTaskSpan, right?: ChatTaskSpan): boolean {
  return !left || !right || left.start < right.end && right.start < left.end;
}
export function chatRunTaskSourceMessageId(requestId: string): string | undefined {
  return /:task-source-v1:([^:]+):task-v1:\d+:\d+$/u.exec(requestId)?.[1];
}
export function chatRunRequestId(messageId: string, dispatchId: string, task?: ChatTaskSpan,
  taskSourceMessageEventId?: string): string {
  const independentSource = taskSourceMessageEventId !== undefined && taskSourceMessageEventId !== messageId;
  if (independentSource && (!task || taskSourceMessageEventId === "" || taskSourceMessageEventId.includes(":"))) {
    throw new Error("An independent Chat task source requires an exact message ID and task span");
  }
  return `chat-execute:${messageId}:${dispatchId}${independentSource ? `:task-source-v1:${taskSourceMessageEventId}` : ""}${task ? `:task-v1:${task.start}:${task.end}` : ""}`;
}

type DispatchAlias = "work" | "event" | "dispatch";
const taskSourceMarker = ":task-source-v1:";
function chatRunBaseSql(alias: DispatchAlias): string {
  return `'chat-execute:' || json_extract(${alias}.payload_json, '$.sourceMessageEventId') || ':' || ${alias}.event_id`;
}
function hasTaskSourceSql(alias: DispatchAlias): string {
  const base = chatRunBaseSql(alias);
  return `substr(run.owner_request_id, 1, length(${base}) + ${taskSourceMarker.length}) = (${base} || '${taskSourceMarker}')`;
}
/** The task source may differ from the dispatch source; the latter still owns callbacks. */
export function chatRunTaskSourceSql(alias: DispatchAlias): string {
  const suffix = `substr(run.owner_request_id, length(${chatRunBaseSql(alias)}) + ${taskSourceMarker.length + 1})`;
  return `CASE WHEN ${hasTaskSourceSql(alias)} THEN substr(${suffix}, 1, instr(${suffix}, ':') - 1)
    ELSE json_extract(${alias}.payload_json, '$.sourceMessageEventId') END`;
}
/** Exact prefix comparison avoids SQL LIKE wildcard semantics in Event IDs. */
export function chatRunOriginSql(alias: DispatchAlias, resumableOnly = false): string {
  const base = chatRunBaseSql(alias);
  const scoped = `substr(run.owner_request_id, 1, length(${base}) + 9) = (${base} || ':task-v1:')`;
  // Request IDs contain prefix:message:dispatch[:task...]. Resolve the Event by
  // its primary key before evaluating the full origin contract against JSON.
  const afterPrefix = "substr(run.owner_request_id, instr(run.owner_request_id, ':') + 1)";
  const afterMessage = `substr(${afterPrefix}, instr(${afterPrefix}, ':') + 1)`;
  const dispatchId = `substr(${afterMessage}, 1, instr(${afterMessage} || ':', ':') - 1)`;
  return `(${alias}.event_id = ${dispatchId} AND (run.owner_request_id = (${base}) OR ${scoped} OR ${hasTaskSourceSql(alias)}${resumableOnly ? "" : ` OR run.owner_request_id = ('chat-work:' || json_extract(${alias}.payload_json, '$.sourceMessageEventId') || ':' || ${alias}.event_id)`}))`;
}
