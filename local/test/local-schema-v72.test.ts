import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateLocalDatabase, LOCAL_SCHEMA_VERSION } from "../src/infrastructure/sqlite/schema/index.js";
import { writeSchemaVersion } from "../src/infrastructure/sqlite/schema/introspection.js";
import { ContinuousSubscriptionStore } from "../src/capabilities/subscription/continuous-store.js";
import { DeterministicApplicationActionRegistry } from "../src/application/proactive/action-registry.js";
import { withImmediateTransaction } from "../src/infrastructure/sqlite/transaction.js";
import { localId } from "../src/core/id.js";

test("v72 file source migration preserves an actual polling row and its pending/checkpoint authority", () => {
  const database = new DatabaseSync(":memory:");
  try {
    migrateLocalDatabase(database);
    const actions = new DeterministicApplicationActionRegistry(database, [{ ref: "action:test/migration@1", inputSchema: "Empty@1",
      parseInput: (value) => value, executeInTransaction: () => ({ status: "succeeded" }) }]);
    const store = new ContinuousSubscriptionStore(database, { applicationActions: actions });
    const id = localId("sub");
    withImmediateTransaction(database, () => store.createTargetedInTransaction({ schemaVersion: "ContinuousSubscriptionDefinition@3",
      revision: 1, subscriptionId: id, title: "existing poll", intervalMilliseconds: 1000,
      probe: { plugin: { id: "old-poll", path: "/old/poll.mjs", config: {} },
        policy: { workspaceRoot: "/old", allowedExecutables: [], allowedHttpOrigins: [], allowedEnvironment: [], timeoutMilliseconds: 1000, maxOutputBytes: 1024 } },
      target: actions.compileTarget("action:test/migration@1", {}) }));
    store.recordObservation(id, { version: "test", occurrenceKey: "confirmed", terminal: null, facts: {} });
    const before = database.prepare("SELECT * FROM continuous_subscriptions").get()!;
    database.exec("DROP TABLE continuous_subscriptions");
    database.exec(readFileSync(resolve(import.meta.dirname, "../../test/fixtures/continuous-subscriptions-v72.sql"), "utf8"));
    const oldColumns = Object.keys(before).filter((key) => !["file_source_json", "file_listener_json"].includes(key));
    database.prepare(`INSERT INTO continuous_subscriptions (${oldColumns.join(",")}) VALUES (${oldColumns.map(() => "?").join(",")})`)
      .run(...oldColumns.map((key) => before[key]!));
    writeSchemaVersion(database, 72);
    migrateLocalDatabase(database);
    const after = database.prepare("SELECT * FROM continuous_subscriptions").get()!;
    for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, key);
    assert.equal(after.file_source_json, null);
    assert.equal(after.file_listener_json, null);
    assert.equal(store.require(id).checkpointOccurrenceKey, "confirmed");
    assert.equal(LOCAL_SCHEMA_VERSION, 80);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { database.close(); }
});
