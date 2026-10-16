import { withImmediateTransaction } from "../transaction.js";
import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { schemaVersion, tableExists, writeSchemaVersion } from "./introspection.js";
import { dropChatProjectionObjects } from "./v44-migration.js";

export function migrateV76Schema(database: DatabaseSync, targetVersion: number): void {
  if (tableExists(database, "chat_rotations") && schemaVersion(database) === targetVersion &&
    hasSharedDispatchProgressTrigger(database)) {
    return;
  }
  withImmediateTransaction(database, () => {
    dropChatProjectionObjects(database);
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
  });
}

function hasSharedDispatchProgressTrigger(database: DatabaseSync): boolean {
  const row = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'trigger' AND name = 'chat_message_project_read_progress_dispatch'
  `).get() as { sql: string } | undefined;
  return row?.sql.includes("json_each(chat_messages.attention_json, '$.receipts')") ?? false;
}
