import assert from "node:assert/strict";
import test from "node:test";

import { readMigrations } from "../src/adapter/persistence/mysql/migrations.js";

test("migration SQL avoids PostgreSQL-only constructs", async () => {
  const migrations = await readMigrations();
  assert.deepEqual(migrations.map((migration) => migration.version), [
    "0001_control_plane",
    "0002_human_device_login",
    "0003_agent_enrollment",
    "0004_room_control_plane",
    "0005_first_login_bootstrap",
    "0006_oidc_device_authorization",
    "0007_profiled_topics",
    "0008_native_topic_fanout",
    "0009_owner_scoped_agent_names",
    "0010_human_topic_publishers",
    "0011_project_connector_runtime",
    "0012_agent_work_requests"
  ]);
  const sql = migrations.map((migration) => migration.sql).join("\n");
  for (const unsupported of [
    /\bJSONB\b/i,
    /\bSERIAL\b/i,
    /\bRETURNING\b/i,
    /::[a-z]/i,
    /\bGENERATED\s+ALWAYS\b/i
  ]) {
    assert.doesNotMatch(sql, unsupported);
  }
});
