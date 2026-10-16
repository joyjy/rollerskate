import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  RunMonitorStore,
  runMonitorSubscriptionId
} from "../src/capabilities/subscription/run-monitor-store.js";
import { localId } from "../src/core/id.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { LOCAL_SCHEMA_VERSION, migrateLocalDatabase } from
  "../src/infrastructure/sqlite/schema/index.js";
import { runSubscriptionSchemaSql } from
  "../src/infrastructure/sqlite/schema/v78-migration.js";
import { temporaryDirectory } from "./support/temp-directory.js";

const T0 = "2026-10-16T01:00:00.000Z";
const T1 = "2026-10-16T01:01:00.000Z";
const T2 = "2026-10-16T01:02:00.000Z";

test("Run Subscription registration rolls back with its Run and preserves checkpoint on retry", () => {
  const database = fixture();
  const store = new RunMonitorStore(database);
  const runId = localId("run");
  assert.throws(() => {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("INSERT INTO agent_runs (run_id, status) VALUES (?, 'active')")
        .run(runId);
      store.createInTransaction(runId, T0);
      throw new Error("admission failed");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }, /admission failed/);
  assert.equal(store.getByRun(runId), undefined);
  assert.equal((database.prepare("SELECT count(*) AS n FROM agent_runs").get() as { n: number }).n, 0);

  database.exec("BEGIN IMMEDIATE");
  database.prepare("INSERT INTO agent_runs (run_id, status) VALUES (?, 'active')").run(runId);
  const created = store.createInTransaction(runId, T0);
  database.exec("COMMIT");
  assert.equal(created.subscriptionId, runMonitorSubscriptionId(runId));
  assert.throws(() => store.checkpointInTransaction(created.subscriptionId, "x", "boot-1", T1),
    /caller-owned transaction/);

  database.exec("BEGIN IMMEDIATE");
  store.checkpointInTransaction(created.subscriptionId, "failed:hash", "boot-1", T1);
  store.setStatusInTransaction(created.subscriptionId, "blocked", "delivery failed", T1);
  const retried = store.createInTransaction(runId, T2);
  database.exec("COMMIT");
  assert.equal(retried.createdAt, T0);
  assert.equal(retried.updatedAt, T1);
  assert.equal(retried.status, "blocked");
  assert.equal(retried.observedKey, "failed:hash");
  assert.equal(retried.runtimeIdentity, "boot-1");
  database.close();
});

test("Run Subscription reopens independently of Run status and lists pending monitors fairly", () => {
  const path = join(temporaryDirectory("rollerskate-run-monitor-"), "runtime.db");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL);");
  database.exec(runSubscriptionSchemaSql);
  const store = new RunMonitorStore(database);
  const firstRunId = localId("run");
  const secondRunId = localId("run");
  database.exec("BEGIN IMMEDIATE");
  database.prepare("INSERT INTO agent_runs VALUES (?, 'active')").run(firstRunId);
  database.prepare("INSERT INTO agent_runs VALUES (?, 'failed')").run(secondRunId);
  const first = store.createInTransaction(firstRunId, T0);
  const second = store.createInTransaction(secondRunId, T1);
  store.checkpointInTransaction(first.subscriptionId, "active", "boot-1", T2);
  database.exec("COMMIT");
  database.close();

  const reopened = new DatabaseSync(path);
  const restored = new RunMonitorStore(reopened);
  assert.equal(restored.get(first.subscriptionId)?.runtimeIdentity, "boot-1");
  assert.deepEqual(restored.listDue().map(({ subscriptionId }) => subscriptionId),
    [second.subscriptionId, first.subscriptionId]);
  assert.equal(restored.getByRun(secondRunId)?.status, "active");
  reopened.exec("BEGIN IMMEDIATE");
  restored.setStatusInTransaction(second.subscriptionId, "completed", null, T2);
  reopened.exec("COMMIT");
  assert.deepEqual(restored.listDue().map(({ subscriptionId }) => subscriptionId),
    [first.subscriptionId]);
  assert.equal((reopened.prepare("SELECT status FROM agent_runs WHERE run_id = ?")
    .get(secondRunId) as { status: string }).status, "failed");
  reopened.close();
});

test("schema v77 upgrades to v78 and fresh schema creates the Run Subscription table", () => {
  const path = join(temporaryDirectory("rollerskate-run-monitor-schema-"), "runtime.db");
  const fresh = initializeRuntimeSchema(path);
  assert.equal(fresh.schemaVersion, LOCAL_SCHEMA_VERSION);
  assert.ok(fresh.tables.includes("run_subscriptions"));

  const database = new DatabaseSync(path);
  database.exec("DROP TABLE run_subscriptions");
  database.prepare("UPDATE schema_meta SET value = '77' WHERE key = 'schema_version'").run();
  migrateLocalDatabase(database);
  migrateLocalDatabase(database);
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'run_subscriptions'").get());
  assert.equal((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length, 0);
  assert.equal((database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string }).value, String(LOCAL_SCHEMA_VERSION));
  database.close();
});

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL);");
  database.exec(runSubscriptionSchemaSql);
  return database;
}
