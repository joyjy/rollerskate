import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "../transaction.js";
import { schemaVersion, tableExists, writeSchemaVersion } from "./introspection.js";

export const runSubscriptionSchemaSql = `
  CREATE TABLE IF NOT EXISTS run_subscriptions (
    subscription_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(run_id),
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active', 'blocked', 'completed')),
    observed_key TEXT,
    runtime_identity TEXT,
    latest_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_subscriptions_status_updated
    ON run_subscriptions(status, updated_at DESC, subscription_id DESC);
`;

export function migrateV78Schema(database: DatabaseSync, targetVersion: number): void {
  if (tableExists(database, "run_subscriptions") && schemaVersion(database) === targetVersion) {
    return;
  }
  withImmediateTransaction(database, () => {
    database.exec(runSubscriptionSchemaSql);
    writeSchemaVersion(database, targetVersion);
  });
}
