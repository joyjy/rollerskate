import type { DatabaseSync } from "node:sqlite";
import { withImmediateTransaction } from "../transaction.js";
import { createSchema } from "./definition.js";
import { writeSchemaVersion } from "./introspection.js";

/** Session identity is session_id; Run/Agent membership is not uniqueness. */
export function migrateV77Schema(database: DatabaseSync, targetVersion: number): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'agent_sessions_run_agent'").get() as {sql: string} | undefined;
  if (row?.sql.includes("CREATE UNIQUE") !== true) return;
  withImmediateTransaction(database, () => {
    database.exec("DROP INDEX agent_sessions_run_agent; DROP INDEX IF EXISTS agent_sessions_run_cycle_agent;");
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
  });
}
