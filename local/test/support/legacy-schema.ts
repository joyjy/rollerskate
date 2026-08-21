import type { DatabaseSync } from "node:sqlite";

export function createLegacySubscriptionCallbacks(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE subscription_callbacks (
      callback_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id)
        ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      kind TEXT NOT NULL CHECK(kind IN (
        'command.exec', 'http.request', 'agent.invoke', 'notification.send'
      )),
      definition_schema TEXT NOT NULL CHECK(
        definition_schema = 'SubscriptionCallbackDefinition@1'
      ),
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
      grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'started', 'succeeded', 'blocked', 'failed', 'unknown'
      )),
      event_id TEXT REFERENCES events(event_id),
      started_at TEXT,
      completed_at TEXT,
      receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(subscription_id, ordinal),
      UNIQUE(subscription_id, callback_id)
    );
    CREATE INDEX subscription_callbacks_status
      ON subscription_callbacks(subscription_id, status, ordinal);
  `);
}
