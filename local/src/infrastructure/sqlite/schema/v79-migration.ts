import type {DatabaseSync} from "node:sqlite";
import {withImmediateTransaction} from "../transaction.js";
import {writeSchemaVersion,schemaVersion,tableExists} from "./introspection.js";

/** Append-only Owner controls; latest revision is current authority. */
export const notificationControlSchemaSql = `
CREATE TABLE IF NOT EXISTS notification_controls (
  scope TEXT NOT NULL CHECK(scope IN ('run','codex-thread')),
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  mode TEXT NOT NULL CHECK(mode IN ('enabled','muted','closed')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope,target_id,revision)
);
`;
export function migrateV79Schema(database: DatabaseSync, version: number): void {
  if(tableExists(database,"notification_controls") && schemaVersion(database)===version) return;
  withImmediateTransaction(database, () => {
    database.exec(notificationControlSchemaSql);
    writeSchemaVersion(database,version);
  });
}
