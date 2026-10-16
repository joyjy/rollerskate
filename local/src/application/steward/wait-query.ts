import { RunMonitorStore } from "../../capabilities/subscription/run-monitor-store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { assertCurrentLocalSchema } from "../../infrastructure/sqlite/schema/index.js";

/** The durable Run ID from start remains the readback key if a waiting caller exits. */
export function readStewardRunWaitOutcome(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string
) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    assertCurrentLocalSchema(database);
    const run = new AgentRunStore(database, { migrate: false }).requireProjection(runId);
    const monitor = new RunMonitorStore(database).getByRun(runId);
    const executions=database.prepare(`SELECT execution.status,execution.attempt_count FROM executions execution
      JOIN events event ON event.event_id=execution.event_id WHERE event.event_id=? OR event.root_event_id=?`)
      .all(run.rootEventId,run.rootEventId) as {status:string;attempt_count:number}[];
    const execution={running:executions.filter(x=>x.status==='running').length,
      queued:executions.filter(x=>x.status==='queued'||x.status==='retry_wait').length,
      attempted:executions.filter(x=>x.attempt_count>0).length};
    const terminal = ["succeeded", "failed", "needs_human", "cancelled"].includes(run.status);
    return {
      schemaVersion: "StewardRunWaitReadback@1" as const,
      runId: run.runId,
      observedAt: new Date().toISOString(),
      execution,
      outcome:terminal?run.status:execution.running>0?'running':execution.attempted===0?'not_started':'unconfirmed',
      semantics:'Only the canonical terminal Run state establishes a completed Run. No terminal state means business success is unconfirmed; waiting caller exit changes no execution.',

      run: {
        status: run.status,
        version: run.version,
        updatedAt: run.updatedAt,
        terminal,
        terminalSummary: run.terminalSummary ?? null
      },
      monitoring: monitor === undefined ? null : {
        subscriptionId: monitor.subscriptionId,
        status: monitor.status,
        latestError: monitor.latestError
      }
    };
  } finally { database.close(); }
}
