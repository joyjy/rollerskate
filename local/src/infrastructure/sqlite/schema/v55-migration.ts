import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "../transaction.js";
import { createSchema } from "./definition.js";
import { preV61ProductTables, writeSchemaVersion } from "./introspection.js";

export const V55_TABLES = [
  "agent_sessions", "agent_runs", "agents", "chat_messages", "chat_presence",
  "continuous_subscriptions", "deliveries", "events", "executions",
  "free_chat_mode_receipts", "free_chat_modes", "local_foundation", "notices",
  "proactive_callback_definitions", "proactive_callback_occurrences",
  "scheduled_runs", "schedules", "schema_meta", "subscriptions",
  "topic_governance", "topic_governance_control_receipts"
] as const;

export function assertV55SchemaShape(database: DatabaseSync): void {
  const actual = preV61ProductTables(database);
  if (actual.length !== V55_TABLES.length || V55_TABLES.some((table) => !actual.includes(table))) {
    throw new Error("Local database schema 55 is incomplete");
  }
}

export function migrateV55Schema(database: DatabaseSync, targetVersion: number): void {
  withImmediateTransaction(database, () => {
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`Local database migration left ${violations.length} foreign key violations`);
    }
  });
}
