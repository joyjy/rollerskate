import type { DatabaseSync } from "node:sqlite";
import { createSchema } from "./definition.js";
import { tableColumns, writeSchemaVersion } from "./introspection.js";

export function migrateV73Schema(database: DatabaseSync, targetVersion: number): void {
  if (tableColumns(database, "external_workflow_recovery_receipts").length > 0) {
    writeSchemaVersion(database, targetVersion);
    return;
  }
  const columns = tableColumns(database, "external_workflow_executions");
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DROP INDEX IF EXISTS external_workflow_executions_due");
    database.exec("ALTER TABLE external_workflow_executions RENAME TO external_workflow_executions_v73");
    createSchema(database);
    const names = columns.map((name) => `"${name}"`).join(", ");
    database.exec(`INSERT INTO external_workflow_executions (${names}) SELECT ${names} FROM external_workflow_executions_v73`);
    database.exec("DROP TABLE external_workflow_executions_v73");
    if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("workflow recovery migration violated foreign keys");
    writeSchemaVersion(database, targetVersion);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally { database.exec("PRAGMA foreign_keys = ON"); }
}
