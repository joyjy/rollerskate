// Legacy origins remain readable; only chat-execute opts into resumable returns.
export function chatRunRequestId(messageId: string, dispatchId: string): string {
  return `chat-execute:${messageId}:${dispatchId}`;
}
export function chatRunOriginSql(alias: "work" | "event" | "dispatch"): string {
  return `run.owner_request_id IN (${["chat-work", "chat-execute"].map(prefix =>
    `'${prefix}:' || json_extract(${alias}.payload_json, '$.sourceMessageEventId') || ':' || ${alias}.event_id`
  ).join(", ")})`;
}
