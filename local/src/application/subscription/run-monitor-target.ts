import type {DatabaseSync} from "node:sqlite";
import type {AgentRunProjection} from "../../modules/steward/state-machine.js";
import {isStewardOrchestrated} from "../../modules/steward/caller-contract.js";
import {chatRunOriginSql} from "../chat/work-origin.js";

export function runMonitorTarget(database: DatabaseSync, run: AgentRunProjection) {
  if (isStewardOrchestrated(run.orchestratorBinding) && run.orchestratorBinding.resultDestination) {
    return {kind: "destination" as const, destination: run.orchestratorBinding.resultDestination};
  }
  const dispatch = database.prepare(`SELECT dispatch.event_id FROM agent_runs run
    JOIN events dispatch ON dispatch.type = 'chat.dispatch' AND ${chatRunOriginSql("dispatch", true)}
    WHERE run.run_id = ?`).get(run.runId) as {event_id: string} | undefined;
  return dispatch ? {kind: "chat" as const, dispatchEventId: dispatch.event_id} : undefined;
}
