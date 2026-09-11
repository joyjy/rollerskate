import type { DatabaseSync } from "node:sqlite";
import { createSchema } from "./definition.js";
import { schemaVersion, tableColumns, writeSchemaVersion } from "./introspection.js";

export function migrateV74Schema(database: DatabaseSync, targetVersion: number): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get() as { sql: string };
  if (row?.sql.includes("codex-desktop")) {
    if (schemaVersion(database) !== targetVersion) writeSchemaVersion(database, targetVersion);
    return;
  }
  if (row === undefined) throw new Error("Local database schema 74 has no Delivery table");
  const columns = tableColumns(database, "deliveries").map(name => `"${name}"`).join(", ");
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS notice_project_delivery_insert;
      DROP TRIGGER IF EXISTS notice_project_delivery_update;
      DROP INDEX IF EXISTS deliveries_due;
      ALTER TABLE deliveries RENAME TO deliveries_v74;
    `);
    createSchema(database);
    database.exec(`INSERT INTO deliveries (${columns}) SELECT ${columns} FROM deliveries_v74`);
    database.exec("DROP TABLE deliveries_v74");
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error("Desktop Delivery migration violated foreign keys");
    writeSchemaVersion(database, targetVersion);
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
  finally { database.exec("PRAGMA foreign_keys = ON"); }
}
