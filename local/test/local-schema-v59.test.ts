import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { dropChatProjectionObjects } from
  "../src/infrastructure/sqlite/schema/v44-migration.js";

const AT = "2026-08-14T08:00:00.000Z";

test("schema v63 extends the public agent_client check and preserves referencing tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v59-agent-check-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.prepare(`
        INSERT INTO agents (
          principal_id, handle, handle_key, status, agent_client, execution_config,
          created_at, updated_at
        ) VALUES (?, 'codex', 'codex', 'active', 'codex', '{"launchArgs":[]}', ?, ?)
      `).run("prn_codex", AT, AT);
      legacy.prepare(`
        INSERT INTO agent_sessions (
          session_id, agent_id, adapter_id, provider_session_id, workspace, created_at, updated_at
        ) VALUES (?, ?, 'codex-runtime-jsonl-v1', ?, ?, ?, ?)
      `).run("ses_codex", "prn_codex", "provider_codex", directory, AT, AT);
      // 把 agents 表降级到 v59 的公开 CHECK，模拟未迁移的 v59 库。
      legacy.exec("PRAGMA foreign_keys = OFF");
      legacy.exec(`
        CREATE TABLE agents_v59 (
          principal_id TEXT PRIMARY KEY,
          handle TEXT NOT NULL,
          handle_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('active', 'suspended')),
          agent_client TEXT NOT NULL
            CHECK(agent_client IN ('codex', 'claude-code', 'kimi-code')),
          execution_config TEXT NOT NULL CHECK(json_valid(execution_config)),
          current_session_id TEXT REFERENCES agent_sessions(session_id),
          session_generation INTEGER NOT NULL DEFAULT 1 CHECK(session_generation >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      legacy.exec(`
        INSERT INTO agents_v59 (
          principal_id, handle, handle_key, status, agent_client, execution_config,
          current_session_id, session_generation, created_at, updated_at
        )
        SELECT principal_id, handle, handle_key, status, agent_client, execution_config,
          current_session_id, session_generation, created_at, updated_at
        FROM agents;
      `);
      dropChatProjectionObjects(legacy);
      legacy.exec("DROP TABLE agents");
      legacy.exec("ALTER TABLE agents_v59 RENAME TO agents");
      legacy.exec("PRAGMA foreign_keys = ON");
      legacy.exec("UPDATE schema_meta SET value = '59' WHERE key = 'schema_version'");
    } finally {
      legacy.close();
    }

    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 63);

    const migrated = new DatabaseSync(databasePath);
    try {
      const codex = migrated.prepare(
        "SELECT agent_client FROM agents WHERE principal_id = ?"
      ).get("prn_codex") as { agent_client: string } | undefined;
      assert.equal(codex?.agent_client, "codex");
      // 当前公开 CHECK 新增允许 Pi。
      migrated.prepare(`
        INSERT INTO agents (
          principal_id, handle, handle_key, status, agent_client, execution_config,
          created_at, updated_at
        ) VALUES (?, 'pi', 'pi', 'active', 'pi', '{"launchArgs":[]}', ?, ?)
      `).run("prn_pi", AT, AT);
      // 引用 agents 的外键在重建后仍有效，且能指向新插入的 agent
      migrated.prepare(`
        INSERT INTO agent_sessions (
          session_id, agent_id, adapter_id, provider_session_id, workspace, created_at, updated_at
        ) VALUES (?, ?, 'pi-runtime-rpc-v1', ?, ?, ?, ?)
      `).run("ses_pi", "prn_pi", "provider_pi", directory, AT, AT);
      const violations = migrated.prepare("PRAGMA foreign_key_check").all();
      assert.equal(violations.length, 0);
      // 非法 client 仍被新 CHECK 拒绝。
      assert.throws(
        () => migrated.prepare(`
          INSERT INTO agents (
            principal_id, handle, handle_key, status, agent_client, execution_config,
            created_at, updated_at
          ) VALUES ('prn_bad', 'bad', 'bad', 'active', 'unknown-client', '{"launchArgs":[]}', ?, ?)
        `).run(AT, AT),
        /CHECK constraint failed/i
      );
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
