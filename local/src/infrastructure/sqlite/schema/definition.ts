import { notificationControlSchemaSql } from "./v79-migration.js";
import type { DatabaseSync } from "node:sqlite";

import { chatRotationSchemaSql } from "./definition/chat-rotation.js";
import { chatProjectionSchemaSql } from "./definition/chat-projection.js";
import { deliverySchemaSql } from "./definition/delivery.js";
import { foundationSchemaSql } from "./definition/foundation.js";
import { noticesSchemaSql } from "./definition/notices.js";
import { runtimeSchemaSql } from "./definition/runtime.js";
import { schedulesSchemaSql } from "./definition/schedules.js";
import { subscriptionsSchemaSql } from "./definition/subscriptions.js";
import { workflowsSchemaSql } from "./definition/workflows.js";
import { runSubscriptionSchemaSql } from "./v78-migration.js";

const schemaSql = [
  foundationSchemaSql,
  runtimeSchemaSql,
  chatRotationSchemaSql,
  chatProjectionSchemaSql,
  deliverySchemaSql,
  subscriptionsSchemaSql,
  workflowsSchemaSql,
  schedulesSchemaSql,
  runSubscriptionSchemaSql,
  notificationControlSchemaSql
].join("\n");

export function createSchema(database: DatabaseSync): void {
  database.exec(schemaSql + noticesSchemaSql);

  createCompatibilityIndexes(database);
}

function createCompatibilityIndexes(database: DatabaseSync): void {
  const runColumns = database.prepare("PRAGMA table_info(agent_runs)").all() as
    unknown as Array<{ name: string }>;
  if (runColumns.some(({ name }) => name === "archived_at")) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS agent_runs_archive_updated
        ON agent_runs(archived_at, updated_at DESC, run_id DESC)
    `);
  }
  for (const [table, idColumn, index] of [
    ["schedules", "schedule_id", "schedules_archive_updated"],
    ["subscriptions", "subscription_id", "subscriptions_archive_updated"],
    [
      "continuous_subscriptions",
      "subscription_id",
      "continuous_subscriptions_archive_updated"
    ]
  ] as const) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as
      unknown as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "archived_at")) {
      database.exec(`
        CREATE INDEX IF NOT EXISTS ${index}
          ON ${table}(archived_at, updated_at DESC, ${idColumn} DESC)
      `);
    }
  }
}
