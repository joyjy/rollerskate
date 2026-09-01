import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { materializeExistingFoundationGovernanceInTransaction } from
  "./v53-migration.js";
import {
  quoteIdentifier,
  productTables,
  rowCount,
  scalarCount,
  tableColumns,
  tableExists,
  writeSchemaVersion
} from "./introspection.js";

export const V60_TARGET_TABLES = [
  "agent_sessions",
  "agent_runs",
  "agents",
  "chat_messages",
  "chat_presence",
  "channel_follows",
  "channel_send_receipts",
  "continuous_subscriptions",
  "deliveries",
  "events",
  "executions",
  "free_chat_mode_receipts",
  "free_chat_modes",
  "interactive_channel_bindings",
  "local_foundation",
  "notices",
  "proactive_callback_definitions",
  "proactive_callback_occurrences",
  "scheduled_runs",
  "schedules",
  "schema_meta",
  "subscriptions",
  "topic_activation_schedule_receipts",
  "topic_activation_schedules",
  "topic_governance",
  "topic_governance_control_receipts"
] as const;

export const TARGET_TABLES = [
  ...V60_TARGET_TABLES,
  "agent_run_cycles",
  "agent_run_decisions",
  "legacy_trigger_migration_receipts"
] as const;

const MIGRATION_SOURCE_TABLES = [...TARGET_TABLES, "subscription_callbacks"] as const;

const COPY_ORDER = [
  "local_foundation",
  "agents",
  "events",
  "executions",
  "agent_runs",
  "agent_sessions",
  "chat_presence",
  "subscriptions",
  "continuous_subscriptions",
  "schedules",
  "scheduled_runs",
  "proactive_callback_definitions",
  "proactive_callback_occurrences",
  "deliveries",
  "notices"
] as const;

export function assertSupportedSchemaShape(
  database: DatabaseSync,
  version: number
): void {
  const governanceTables = [
    "topic_governance",
    "topic_governance_control_receipts"
  ];
  const freeChatTables = ["free_chat_modes", "free_chat_mode_receipts"];
  const slice56Tables = [
    "channel_follows", "channel_send_receipts", "interactive_channel_bindings",
    "topic_activation_schedule_receipts", "topic_activation_schedules"
  ];
  const callerRunTables = [
    "agent_run_decisions",
    "legacy_trigger_migration_receipts"
  ];
  const excluded = version === 44
    ? new Set([
        "continuous_subscriptions",
        "proactive_callback_definitions",
        "proactive_callback_occurrences",
        ...governanceTables,
        ...freeChatTables,
        ...slice56Tables,
        ...callerRunTables
      ])
    : version <= 46
      ? new Set([
          "continuous_subscriptions",
          "proactive_callback_definitions",
          "proactive_callback_occurrences",
          ...governanceTables,
          ...freeChatTables,
          ...slice56Tables,
          ...callerRunTables
        ])
      : new Set([
          ...governanceTables,
          ...freeChatTables,
          ...slice56Tables,
          ...callerRunTables
        ]);
  const expected = [
    ...V60_TARGET_TABLES.filter((table) => !excluded.has(table)),
    ...(version >= 45 && version <= 51 ? ["subscription_callbacks"] : [])
  ];
  const actual = productTables(database).filter((table) =>
    table !== "reviews" &&
    table !== "agent_run_cycles" &&
    !governanceTables.includes(table) &&
    !freeChatTables.includes(table) &&
    !slice56Tables.includes(table) &&
    !callerRunTables.includes(table));
  if (actual.length !== expected.length ||
    expected.some((table) => !actual.includes(table))) {
    throw new Error(`Local database schema ${version} is incomplete`);
  }
}

export function hasAnyProductTable(database: DatabaseSync): boolean {
  const row = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name != 'schema_meta'
    LIMIT 1
  `).get();
  return row !== undefined;
}

export function migrateV44Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    dropProjectionObjects(database);
    const renamed = renameProductTables(database);
    createSchema(database);
    dropNoticeProjectionTriggers(database);
    copySupportedData(database, renamed);
    settleLegacySubscriptionCallbacks(database, renamed.get("subscription_callbacks"));
    backfillChatMessages(database);
    verifyCopy(database, renamed);
    if (tableExists(database, "reviews")) database.exec("DROP TABLE reviews");
    for (const table of renamed.values()) {
      if (tableExists(database, table)) database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
    }
    createSchema(database);
    materializeExistingFoundationGovernanceInTransaction(database);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Local database migration left ${violations.length} foreign key violations`
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

export function dropChatProjectionObjects(database: DatabaseSync): void {
  database.exec(dropChatProjectionObjectsSql());
}

export function backfillChatMessages(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO chat_messages (
      event_id, topic_id, sender_kind, sender_principal_id,
      sender_handle_snapshot, body, target_principal_id,
      target_handle_snapshot, created_at, attention_json,
      read_progress_json, projected_at
    )
    SELECT
      event.event_id,
      json_extract(event.payload_json, '$.topicId'),
      json_extract(event.payload_json, '$.sender.kind'),
      json_extract(event.payload_json, '$.sender.principalId'),
      json_extract(event.payload_json, '$.sender.handleSnapshot'),
      json_extract(event.payload_json, '$.body'),
      json_extract(event.payload_json, '$.target.principalId'),
      json_extract(event.payload_json, '$.target.handleSnapshot'),
      event.created_at,
      CASE
        WHEN json_extract(execution.receipt_json, '$.schema') =
          'ChatAttentionReceiptList@1'
        THEN execution.receipt_json
        ELSE NULL
      END,
      NULL,
      COALESCE(execution.updated_at, event.created_at)
    FROM events AS event
    LEFT JOIN executions AS execution ON execution.event_id = event.event_id
    WHERE event.type = 'chat.message'
    ON CONFLICT(event_id) DO UPDATE SET
      topic_id = excluded.topic_id,
      sender_kind = excluded.sender_kind,
      sender_principal_id = excluded.sender_principal_id,
      sender_handle_snapshot = excluded.sender_handle_snapshot,
      body = excluded.body,
      target_principal_id = excluded.target_principal_id,
      target_handle_snapshot = excluded.target_handle_snapshot,
      created_at = excluded.created_at,
      attention_json = excluded.attention_json,
      projected_at = excluded.projected_at;
    UPDATE chat_messages
    SET read_progress_json = (
      SELECT progress_json
      FROM chat_message_read_progress_v1
      WHERE event_id = chat_messages.event_id
    );
  `);
}

function renameProductTables(database: DatabaseSync): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const table of MIGRATION_SOURCE_TABLES) {
    if (!tableExists(database, table)) continue;
    const source = `_v44_${table}`;
    database.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(source)}`);
    database.exec(
      `ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(source)}`
    );
    renamed.set(table, source);
  }
  return renamed;
}

function copySupportedData(
  database: DatabaseSync,
  renamed: ReadonlyMap<string, string>
): void {
  for (const table of COPY_ORDER) {
    const source = renamed.get(table);
    if (source === undefined) continue;
    if (table === "events") {
      copyEvents(database, source, renamed.get("subscriptions"));
    } else if (table === "executions") {
      copyExecutions(database, source);
    } else if (table === "agent_runs") {
      copyAgentRuns(database, source);
    } else if (table === "subscriptions") {
      copySubscriptions(database, source);
    } else if (table === "deliveries") {
      copyDeliveries(database, source);
    } else if (table === "notices") {
      copyNotices(database, source);
    } else {
      copyCompatibleTable(database, table, source);
    }
  }
}

function copyEvents(
  database: DatabaseSync,
  source: string,
  subscriptionSource: string | undefined
): void {
  const columns = tableColumns(database, "events").map(quoteIdentifier).join(", ");
  const legacySubscriptionRoots = subscriptionSource !== undefined &&
    tableColumns(database, subscriptionSource).includes("fire_event_id")
    ? `AND root_event_id NOT IN (
        SELECT fire_event_id FROM ${quoteIdentifier(subscriptionSource)}
        WHERE fire_event_id IS NOT NULL
      )`
    : "";
  database.exec(`
    INSERT INTO events (${columns})
    SELECT ${columns} FROM ${quoteIdentifier(source)}
    WHERE root_event_id NOT IN (
      SELECT event_id FROM ${quoteIdentifier(source)}
      WHERE type IN ('review.requested', 'review.decision')
    )
      ${legacySubscriptionRoots}
  `);
}

function copyExecutions(database: DatabaseSync, source: string): void {
  const columns = tableColumns(database, "executions").map(quoteIdentifier).join(", ");
  database.exec(`
    INSERT INTO executions (${columns})
    SELECT ${columns} FROM ${quoteIdentifier(source)} AS execution
    WHERE execution.handler != 'review'
      AND EXISTS (SELECT 1 FROM events WHERE event_id = execution.event_id)
  `);
}

function copyAgentRuns(database: DatabaseSync, source: string): void {
  const sourceColumns = new Set(tableColumns(database, source));
  const columns = tableColumns(database, "agent_runs")
    .filter((column) => sourceColumns.has(column))
    .map(quoteIdentifier)
    .join(", ");
  database.exec(`
    INSERT INTO agent_runs (${columns})
    SELECT ${columns} FROM ${quoteIdentifier(source)} AS run
    WHERE EXISTS (SELECT 1 FROM events WHERE event_id = run.root_event_id)
      AND (run.active_execution_id IS NULL OR EXISTS (
        SELECT 1 FROM executions WHERE execution_id = run.active_execution_id
      ))
  `);
}

function copySubscriptions(database: DatabaseSync, source: string): void {
  if (!hasEveryTargetColumn(database, "subscriptions", source)) return;
  const columns = tableColumns(database, "subscriptions").map(quoteIdentifier).join(", ");
  database.exec(`
    INSERT INTO subscriptions (${columns})
    SELECT ${columns} FROM ${quoteIdentifier(source)}
    WHERE definition_schema = 'SubscriptionDefinition@3'
  `);
}

function settleLegacySubscriptionCallbacks(
  database: DatabaseSync,
  callbackSource: string | undefined
): void {
  if (callbackSource === undefined) return;
  database.exec(`
    UPDATE subscriptions
    SET callback_phase_status = CASE
      WHEN EXISTS (
        SELECT 1 FROM ${quoteIdentifier(callbackSource)} AS callback
        WHERE callback.subscription_id = subscriptions.subscription_id
      ) THEN 'completed_with_unknown'
      ELSE 'completed'
    END
    WHERE status = 'completed' AND callback_phase_status IN ('pending', 'running')
  `);
}

function copyDeliveries(database: DatabaseSync, source: string): void {
  if (hasEveryTargetColumn(database, "deliveries", source)) {
    const columns = tableColumns(database, "deliveries").map(quoteIdentifier).join(", ");
    database.exec(`
      INSERT INTO deliveries (${columns})
      SELECT ${columns} FROM ${quoteIdentifier(source)} AS delivery
      WHERE delivery.result_event_id IS NULL OR EXISTS (
        SELECT 1 FROM events WHERE event_id = delivery.result_event_id
      )
    `);
    return;
  }
  database.exec(`
    INSERT INTO deliveries (
      delivery_id, result_event_id, origin_kind, origin_id, destination_id,
      destination_kind, destination_address_json, payload_json, status,
      attempt_count, max_attempts, next_attempt_at, receipt, last_error,
      created_at, updated_at
    )
    SELECT delivery_id, result_event_id, 'event', result_event_id, destination_id,
      destination_kind, destination_address_json, '{}', status,
      attempt_count, max_attempts, next_attempt_at, receipt, last_error,
      created_at, updated_at
    FROM ${quoteIdentifier(source)} AS delivery
    WHERE EXISTS (SELECT 1 FROM events WHERE event_id = delivery.result_event_id)
  `);
}

function copyNotices(database: DatabaseSync, source: string): void {
  if (!hasEveryTargetColumn(database, "notices", source)) return;
  const columns = tableColumns(database, "notices").map(quoteIdentifier).join(", ");
  database.exec(`
    INSERT INTO notices (${columns})
    SELECT ${columns} FROM ${quoteIdentifier(source)} AS notice
    WHERE EXISTS (
      SELECT 1 FROM deliveries WHERE delivery_id = notice.source_id
    )
  `);
}

function copyCompatibleTable(
  database: DatabaseSync,
  table: string,
  source: string
): void {
  if (!hasEveryTargetColumn(database, table, source)) {
    throw new Error(`Local schema v44 migration cannot copy ${table}`);
  }
  const columns = tableColumns(database, table).map(quoteIdentifier).join(", ");
  database.exec(`
    INSERT INTO ${quoteIdentifier(table)} (${columns})
    SELECT ${columns} FROM ${quoteIdentifier(source)}
  `);
}

function hasEveryTargetColumn(
  database: DatabaseSync,
  table: string,
  source: string
): boolean {
  const sourceColumns = new Set(tableColumns(database, source));
  return tableColumns(database, table).every((column) => sourceColumns.has(column));
}

function verifyCopy(
  database: DatabaseSync,
  renamed: ReadonlyMap<string, string>
): void {
  const eventSource = renamed.get("events");
  if (eventSource !== undefined) {
    const subscriptionSource = renamed.get("subscriptions");
    const legacySubscriptionRoots = subscriptionSource !== undefined &&
      tableColumns(database, subscriptionSource).includes("fire_event_id")
      ? `AND root_event_id NOT IN (
          SELECT fire_event_id FROM ${quoteIdentifier(subscriptionSource)}
          WHERE fire_event_id IS NOT NULL
        )`
      : "";
    const expected = scalarCount(database, `
      SELECT COUNT(*) AS count FROM ${quoteIdentifier(eventSource)}
      WHERE root_event_id NOT IN (
        SELECT event_id FROM ${quoteIdentifier(eventSource)}
        WHERE type IN ('review.requested', 'review.decision')
      )
        ${legacySubscriptionRoots}
    `);
    if (rowCount(database, "events") !== expected) {
      throw new Error("Local schema v44 migration did not preserve supported Events");
    }
  }
  const chatEvents = scalarCount(database, `
    SELECT COUNT(*) AS count FROM events WHERE type = 'chat.message'
  `);
  if (rowCount(database, "chat_messages") !== chatEvents) {
    throw new Error("Local schema v44 migration did not rebuild Chat messages");
  }
}

function dropProjectionObjects(database: DatabaseSync): void {
  database.exec(`
    ${dropNoticeProjectionTriggersSql()}
    ${dropChatProjectionObjectsSql()}
  `);
}

function dropNoticeProjectionTriggers(database: DatabaseSync): void {
  database.exec(dropNoticeProjectionTriggersSql());
}

function dropNoticeProjectionTriggersSql(): string {
  return `
    DROP TRIGGER IF EXISTS notice_project_delivery_insert;
    DROP TRIGGER IF EXISTS notice_project_delivery_update;
    DROP TRIGGER IF EXISTS notice_project_destination_update;
  `;
}

function dropChatProjectionObjectsSql(): string {
  return `
    DROP TRIGGER IF EXISTS chat_message_project_event_insert;
    DROP TRIGGER IF EXISTS chat_message_project_attention_update;
    DROP TRIGGER IF EXISTS chat_message_project_read_progress_attention;
    DROP TRIGGER IF EXISTS chat_message_project_read_progress_dispatch;
    DROP VIEW IF EXISTS chat_message_read_progress_v1;
  `;
}
