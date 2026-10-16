import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { WebSearchAccessStore } from "../../infrastructure/files/web-search-access-store.js";
import { nativeWebSearchCapability } from "../../modules/agent/web-search.js";
import type { AgentClient } from "../../modules/agent/client-profile.js";
import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import { chatActionDispatch } from "./action-scope.js";

function store(repoRoot: string, runtimeDirectory?: string) {
  return new WebSearchAccessStore(runtimePaths(repoRoot, runtimeDirectory).webSearchAccess);
}
export function inspectWebSearchAccess(repoRoot: string, agentId: string, client: AgentClient, runtimeDirectory?: string) {
  const grant = store(repoRoot, runtimeDirectory).inspect(agentId);
  return { status: grant?.status ?? "revoked", ...nativeWebSearchCapability(client) };
}
export function setWebSearchAccess(repoRoot: string, agentId: string, enabled: boolean, runtimeDirectory?: string) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const foundation = new LocalFoundationStore(database, { migrate: false });
    const local = foundation.foundation();
    const agent = foundation.listAgents().find(agent => agent.principalId === agentId);
    if (!local || agent?.status !== "active") throw new Error("Web search access requires an active local Agent");
    if (enabled && !nativeWebSearchCapability(agent.client).supported) throw new Error("This client has no supported native search switch");
    const participant = database.prepare(`SELECT 1 FROM topic_governance t, json_each(t.participants_json) p
      WHERE t.topic_id = ? AND json_extract(p.value, '$.agentId') = ?
      AND json_extract(p.value, '$.status') = 'active'`).get(local.topicId, agentId);
    if (enabled && !participant) throw new Error("Add this participant before enabling tools");
    store(repoRoot, runtimeDirectory).set(agentId, local.owner.principalId, enabled);
    return inspectWebSearchAccess(repoRoot, agentId, agent.client, runtimeDirectory);
  } finally { database.close(); }
}
/** Resolve at actual invocation, never from model-authored prompt text or stale UI state. */
export function chatWebSearchEnabled(repoRoot: string, event: AgentInputEvent | ChatDispatchEvent, runtimeDirectory?: string): boolean {
  if (event.type !== "chat.dispatch") return false;
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const runtime = new RuntimeStore(database, { migrate: false });
    const dispatch = chatActionDispatch({ repoRoot, ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }), dispatchEventId: event.eventId }, database, runtime);
    const foundation = new LocalFoundationStore(database, { migrate: false });
    const local = foundation.foundation();
    const agent = foundation.listAgents().find(agent => agent.principalId === dispatch.agentId);
    const grant = store(repoRoot, runtimeDirectory).inspect(dispatch.agentId);
    return local !== undefined && local.topicId === dispatch.topicId && agent !== undefined &&
      nativeWebSearchCapability(agent.client).supported && grant?.status === "active" &&
      grant.ownerPrincipalId === local.owner.principalId;
  } catch { return false; } finally { database.close(); }
}
