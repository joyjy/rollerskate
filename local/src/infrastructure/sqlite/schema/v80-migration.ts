import type {DatabaseSync} from "node:sqlite";
import {withImmediateTransaction} from "../transaction.js";
import {writeSchemaVersion, schemaVersion} from "./introspection.js";

/** Opt-in observation state stays in its owning Subscription; legacy rows remain NULL. */
export function migrateV80Schema(database: DatabaseSync, version: number): void {
  const columns = database.prepare("PRAGMA table_info(subscriptions)").all() as {name:string}[];
  if (columns.some(column => column.name === "observation_state_json") && schemaVersion(database) === version) return;
  withImmediateTransaction(database, () => {
    if (!columns.some(column => column.name === "observation_state_json")) {
      database.exec(`ALTER TABLE subscriptions ADD COLUMN observation_state_json TEXT
        CHECK(observation_state_json IS NULL OR (json_valid(observation_state_json) AND length(observation_state_json) <= 16384))`);
    }
    writeSchemaVersion(database, version);
  });
}
