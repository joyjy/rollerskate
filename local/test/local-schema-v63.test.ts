import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { startStewardRun } from "../src/application/steward/control.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v74 adds reversible archive visibility without changing Run lifecycle", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schema-v63-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v63-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  try {
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-08-24T00:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("steward", "codex", "2026-08-24T00:00:00.000Z");
    foundation.close();
    const started = startStewardRun(repo, {
      requestId: "schema-v63-run",
      steward: "steward",
      objective: "preserve this Run"
    }, runtimeDirectory, "2026-08-24T00:00:01.000Z");

    const legacy = new DatabaseSync(paths.database);
    try {
      legacy.exec(`
        DROP INDEX agent_runs_archive_updated;
        ALTER TABLE agent_runs DROP COLUMN archived_at;
        UPDATE schema_meta SET value = '63' WHERE key = 'schema_version';
      `);
    } finally {
      legacy.close();
    }

    assert.equal(initializeRuntimeSchema(paths.database).schemaVersion, 80);
    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      const columns = database.prepare("PRAGMA table_info(agent_runs)").all() as
        unknown as Array<{ name: string }>;
      assert.equal(columns.some(({ name }) => name === "archived_at"), true);
    } finally {
      database.close();
    }
    const runs = new AgentRunStore(paths.database);
    try {
      const preserved = runs.requireProjection(started.run.runId);
      assert.equal(preserved.status, "active");
      assert.equal(preserved.archivedAt, undefined);
    } finally {
      runs.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
