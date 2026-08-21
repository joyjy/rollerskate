import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";
import { dropChatProjectionObjects } from "./v44-migration.js";

export function assertV59SchemaShape(database: DatabaseSync): void {
  if (!tableExists(database, "agents") ||
    !tableColumns(database, "agents").includes("agent_client")) {
    throw new Error("Local database schema 59 is missing the agents table");
  }
}

export function migrateV59Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    // chat projection view/trigger 引用 agents，先 drop 否则 DROP TABLE agents 会失败；
    // 后面的 createSchema 会按 IF NOT EXISTS 重新创建它们。
    dropChatProjectionObjects(database);
    // 重建 agents 表以扩展 agent_client CHECK 约束。
    // 先建新表再 copy 再 drop 旧表，最后 rename 回原名：不能 rename 旧表到 _old，
    // 因为 SQLite 会把其他表引用 agents(principal_id) 的外键改写成指向 _old。
    database.exec(`
      CREATE TABLE agents_v59 (
        principal_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        handle_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('active', 'suspended')),
        agent_client TEXT NOT NULL
          CHECK(agent_client IN ('codex', 'claude-code', 'kimi-code', 'pi')),
        execution_config TEXT NOT NULL CHECK(json_valid(execution_config)),
        current_session_id TEXT REFERENCES agent_sessions(session_id),
        session_generation INTEGER NOT NULL DEFAULT 1 CHECK(session_generation >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    database.exec(`
      INSERT INTO agents_v59 (
        principal_id, handle, handle_key, status, agent_client,
        execution_config, current_session_id, session_generation, created_at, updated_at
      )
      SELECT principal_id, handle, handle_key, status, agent_client,
        execution_config, current_session_id, session_generation, created_at, updated_at
      FROM agents;
    `);
    database.exec("DROP TABLE agents");
    database.exec("ALTER TABLE agents_v59 RENAME TO agents");
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Local database migration left ${violations.length} foreign key violations`
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
