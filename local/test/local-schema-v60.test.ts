import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { startStewardRun } from "../src/application/steward/control.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v74 preserves v60 autonomous Runs and adds caller decision state", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schema-v60-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v60-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  try {
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-08-18T01:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("a", "codex", "2026-08-18T01:00:00.000Z");
    foundation.close();
    const started = startStewardRun(repo, {
      requestId: "legacy-autonomous-run",
      steward: "a",
      objective: "preserve this Run"
    }, runtimeDirectory, "2026-08-18T01:00:01.000Z");

    insertLegacyWorkflowResult(paths.database, started.run.rootEventId);

    downgradeAgentRunsToV60(paths.database);
    assert.equal(declaredVersion(paths.database), 60);
    assert.equal(initializeRuntimeSchema(paths.database).schemaVersion, 75);

    const database = new DatabaseSync(paths.database);
    try {
      const columns = database.prepare("PRAGMA table_info(agent_runs)").all() as
        unknown as Array<{ name: string }>;
      assert.equal(columns.some(({ name }) => name === "orchestration_mode"), true);
      assert.equal(columns.some(({ name }) => name === "checkpoint_json"), true);
      assert.notEqual(database.prepare(`
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'agent_run_decisions'
      `).get(), undefined);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      const migrated = database.prepare(`
        SELECT output FROM events WHERE event_id = 'evt_legacy_workflow_result'
      `).get() as { output: string };
      const output = JSON.parse(migrated.output) as Record<string, unknown>;
      assert.equal("workflowResult" in output, false);
      assert.deepEqual(output.outputs, [{
        id: "result",
        title: "Workflow result",
        contentType: "application/json",
        schemaVersion: "MrReadinessResult@1",
        value: { schemaVersion: "MrReadinessResult@1", completeness: "complete" }
      }]);
    } finally {
      database.close();
    }
    const runs = new AgentRunStore(paths.database);
    try {
      const preserved = runs.requireProjection(started.run.runId);
      assert.equal(preserved.orchestrationMode, "autonomous");
      assert.equal(preserved.status, "active");
      assert.equal(preserved.orchestratorBinding, undefined);
    } finally {
      runs.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function declaredVersion(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT value FROM schema_meta WHERE key = 'schema_version'
    `).get() as { value: string };
    return Number(row.value);
  } finally {
    database.close();
  }
}

function insertLegacyWorkflowResult(path: string, rootEventId: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, agent_id, outcome, output,
        destination_ids_json, destination_snapshots_json,
        root_event_id, parent_event_id, causal_hop, created_at
      ) VALUES (?, 'agent.result', 'handler', 'a', 'succeeded', ?, '[]', '[]', ?, ?, 1, ?)
    `).run(
      "evt_legacy_workflow_result",
      JSON.stringify({
        schemaVersion: "AgentTurnResult@1",
        action: "complete",
        outcome: "succeeded",
        summary: "ready",
        artifactRefs: [],
        workflowResult: {
          schemaVersion: "MrReadinessResult@1",
          completeness: "complete"
        }
      }),
      rootEventId,
      rootEventId,
      "2026-08-18T01:00:02.000Z"
    );
  } finally {
    database.close();
  }
}

function downgradeAgentRunsToV60(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DROP TABLE agent_run_decisions");
    database.exec(`
      CREATE TABLE agent_runs_v60_fixture (
        run_id TEXT PRIMARY KEY,
        root_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        owner_request_id TEXT NOT NULL UNIQUE,
        owner_principal_id TEXT NOT NULL,
        steward_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
        mandate_snapshot_json TEXT NOT NULL CHECK(
          json_valid(mandate_snapshot_json) AND length(mandate_snapshot_json) <= 65536
        ),
        workspace_grant_json TEXT CHECK(
          workspace_grant_json IS NULL OR (
            json_valid(workspace_grant_json) AND length(workspace_grant_json) <= 16384
          )
        ),
        status TEXT NOT NULL CHECK(status IN (
          'active', 'waiting', 'succeeded', 'failed', 'needs_human', 'cancelled'
        )),
        active_step_id TEXT,
        active_execution_id TEXT REFERENCES executions(execution_id),
        step_count INTEGER NOT NULL CHECK(step_count >= 1),
        max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 1000),
        max_depth INTEGER NOT NULL CHECK(max_depth BETWEEN 0 AND 100),
        deadline_at TEXT,
        terminal_summary TEXT,
        cancelled_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_runs_v60_fixture (
        run_id, root_event_id, owner_request_id, owner_principal_id,
        steward_agent_id, mandate_snapshot_json, workspace_grant_json,
        status, active_step_id, active_execution_id, step_count,
        max_steps, max_depth, deadline_at, terminal_summary, cancelled_at,
        version, created_at, updated_at
      )
      SELECT
        run_id, root_event_id, owner_request_id, owner_principal_id,
        steward_agent_id, mandate_snapshot_json, workspace_grant_json,
        status, active_step_id, active_execution_id, step_count,
        max_steps, max_depth, deadline_at, terminal_summary, cancelled_at,
        version, created_at, updated_at
      FROM agent_runs;
      DROP TABLE agent_runs;
      ALTER TABLE agent_runs_v60_fixture RENAME TO agent_runs;
      UPDATE schema_meta SET value = '60' WHERE key = 'schema_version';
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
    database.close();
  }
}
