import type { DatabaseSync } from "node:sqlite";
import { createSchema } from "./definition.js";
import { tableColumns, writeSchemaVersion } from "./introspection.js";

export function migrateV72Schema(database: DatabaseSync, targetVersion: number): void {
  // Earlier migrations use current DDL; only a real v72 table needs rebuilding.
  if (tableColumns(database, "continuous_subscriptions").includes("file_source_json")) {
    writeSchemaVersion(database, targetVersion);
    return;
  }
  const columns = tableColumns(database, "continuous_subscriptions");
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'continuous_subscriptions' AND sql IS NOT NULL").all() as Array<{ name: string }>;
    for (const { name } of indexes) database.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
    database.exec("ALTER TABLE continuous_subscriptions RENAME TO continuous_subscriptions_v72");
    createSchema(database);
    const names = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
    database.exec(`INSERT INTO continuous_subscriptions (${names}) SELECT ${names} FROM continuous_subscriptions_v72`);
    database.exec("DROP TABLE continuous_subscriptions_v72");
    if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("file source migration violated foreign keys");
    writeSchemaVersion(database, targetVersion);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally { database.exec("PRAGMA foreign_keys = ON"); }
}
