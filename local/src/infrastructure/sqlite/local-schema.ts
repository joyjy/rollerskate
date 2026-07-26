import type { DatabaseSync } from "node:sqlite";

export const LOCAL_SCHEMA_VERSION = 44;

const TARGET_TABLES = [
  "agent_sessions",
  "agent_runs",
  "agents",
  "chat_messages",
  "chat_presence",
  "deliveries",
  "events",
  "executions",
  "local_foundation",
  "notices",
  "reviews",
  "scheduled_runs",
  "schedules",
  "schema_meta",
  "subscriptions"
] as const;

const LEGACY_TABLES = [
  "chat_agent_presence",
  "chat_attention_receipts",
  "chat_decision_receipts",
  "destinations",
  "local_agent_profiles",
  "local_agent_sessions",
  "local_agents",
  "local_chat_dispatches",
  "local_chat_prompts",
  "local_device_registration",
  "local_principals",
  "matrix_bindings",
  "notice_index",
  "notice_states",
  "poll_subscriptions",
  "review_chains",
  "review_role_sessions",
  "review_transitions",
  "schedule_definitions",
  "schedule_revisions",
  "server_agent_bindings",
  "server_connections",
  "server_device_bindings",
  "sessions"
] as const;

export function migrateLocalDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  const declaredVersion = schemaVersion(database);
  if (declaredVersion !== undefined && declaredVersion > LOCAL_SCHEMA_VERSION) {
    throw new Error(
      `Local database schema ${declaredVersion} is newer than supported ${LOCAL_SCHEMA_VERSION}`
    );
  }
  if (isCurrentSchema(database)) {
    dropChatProjectionObjects(database);
    createSchema(database);
    return;
  }
  if (declaredVersion === LOCAL_SCHEMA_VERSION) {
    throw new Error(`Local database schema ${LOCAL_SCHEMA_VERSION} is incomplete`);
  }
  if (declaredVersion !== undefined && declaredVersion !== 42 &&
    declaredVersion !== 43 &&
    hasAnyProductTable(database)) {
    throw new Error(
      `Local database schema ${declaredVersion} cannot migrate directly to ${LOCAL_SCHEMA_VERSION}`
    );
  }
  if (hasAnyProductTable(database)) {
    migrateLegacySchema(database);
    return;
  }
  createSchema(database);
  writeSchemaVersion(database);
}

export function rebuildChatMessageProjection(database: DatabaseSync): {
  readonly messages: number;
  readonly withReadProgress: number;
} {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM chat_messages");
    backfillChatMessages(database);
    const messages = rowCount(database, "chat_messages");
    const canonicalMessages = scalarCount(database, `
      SELECT COUNT(*) AS count FROM events WHERE type = 'chat.message'
    `);
    if (messages !== canonicalMessages) {
      throw new Error(
        `Chat projection rebuild did not preserve every message: ` +
        `${canonicalMessages} -> ${messages}`
      );
    }
    const withReadProgress = scalarCount(database, `
      SELECT COUNT(*) AS count
      FROM chat_messages
      WHERE read_progress_json IS NOT NULL
    `);
    database.exec("COMMIT");
    return { messages, withReadProgress };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function isCurrentSchema(database: DatabaseSync): boolean {
  if (schemaVersion(database) !== LOCAL_SCHEMA_VERSION) return false;
  const tables = productTables(database);
  return tables.length === TARGET_TABLES.length &&
    TARGET_TABLES.every((table) => tables.includes(table));
}

function hasAnyProductTable(database: DatabaseSync): boolean {
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

function migrateLegacySchema(database: DatabaseSync): void {
  if (tableExists(database, "reviews")) {
    const activeLegacyReviews = scalarCount(database, `
      SELECT COUNT(*) AS count FROM reviews WHERE phase != 'terminal'
    `);
    if (activeLegacyReviews > 0) {
      throw new Error(
        `Local database has ${activeLegacyReviews} active legacy Review(s); ` +
        "finish or recover them with the previous Runtime before upgrading"
      );
    }
  }
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS notice_project_delivery_insert;
      DROP TRIGGER IF EXISTS notice_project_delivery_update;
      DROP TRIGGER IF EXISTS notice_project_destination_update;
      ${dropChatProjectionObjectsSql()}
    `);
    const renamed = new Map<string, string>();
    for (const table of TARGET_TABLES) {
      if (!tableExists(database, table)) continue;
      const legacyName = `_v42_${table}`;
      database.exec(`DROP TABLE IF EXISTS "${legacyName}"`);
      database.exec(`ALTER TABLE "${table}" RENAME TO "${legacyName}"`);
      renamed.set(table, legacyName);
    }
    createSchema(database);
    const copiedCurrentShape = copyLegacyData(database, renamed);
    backfillChatMessages(database);
    verifyLegacyCopy(database, renamed, copiedCurrentShape);
    for (const table of LEGACY_TABLES) {
      if (tableExists(database, table)) database.exec(`DROP TABLE "${table}"`);
    }
    for (const table of renamed.values()) {
      if (tableExists(database, table)) database.exec(`DROP TABLE "${table}"`);
    }
    writeSchemaVersion(database);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`Local database migration left ${violations.length} foreign key violations`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function dropChatProjectionObjects(database: DatabaseSync): void {
  database.exec(dropChatProjectionObjectsSql());
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

function verifyLegacyCopy(
  database: DatabaseSync,
  renamed: ReadonlyMap<string, string>,
  copiedCurrentShape: ReadonlySet<string>
): void {
  const oldSessions = renamed.get("agent_sessions") ??
    (tableExists(database, "sessions") ? "sessions" : undefined);
  const copies: Array<readonly [string | undefined, string]> = [
    [renamed.get("local_foundation"), "local_foundation"],
    [oldSessions, "agent_sessions"],
    [
      copiedCurrentShape.has("agents")
        ? renamed.get("agents")
        : tableExists(database, "local_agent_profiles")
          ? "local_agent_profiles"
          : undefined,
      "agents"
    ],
    [renamed.get("events"), "events"],
    [renamed.get("executions"), "executions"],
    [renamed.get("deliveries"), "deliveries"],
    [
      copiedCurrentShape.has("chat_presence")
        ? renamed.get("chat_presence")
        : tableExists(database, "chat_agent_presence")
          ? "chat_agent_presence"
          : undefined,
      "chat_presence"
    ],
    [
      copiedCurrentShape.has("subscriptions")
        ? renamed.get("subscriptions")
        : tableExists(database, "poll_subscriptions")
          ? "poll_subscriptions"
          : undefined,
      "subscriptions"
    ],
    [
      copiedCurrentShape.has("schedules")
        ? renamed.get("schedules")
        : tableExists(database, "schedule_definitions")
          ? "schedule_definitions"
          : undefined,
      "schedules"
    ],
    [renamed.get("scheduled_runs"), "scheduled_runs"],
    [
      copiedCurrentShape.has("reviews")
        ? renamed.get("reviews")
        : tableExists(database, "review_chains")
          ? "review_chains"
          : undefined,
      "reviews"
    ],
    [
      copiedCurrentShape.has("notices")
        ? renamed.get("notices")
        : tableExists(database, "notice_index")
          ? "notice_index"
          : undefined,
      "notices"
    ]
  ];
  for (const [source, target] of copies) {
    if (source === undefined) continue;
    const sourceCount = rowCount(database, source);
    const targetCount = rowCount(database, target);
    if (sourceCount !== targetCount) {
      throw new Error(
        `Local database migration did not preserve ${source}: ${sourceCount} -> ${targetCount}`
      );
    }
  }

  const incompleteDestinations = scalarCount(database, `
    SELECT COUNT(*) AS count
    FROM events
    WHERE json_array_length(destination_ids_json) !=
      json_array_length(destination_snapshots_json)
  `);
  if (incompleteDestinations > 0) {
    throw new Error(
      `Local database migration could not snapshot ${incompleteDestinations} Event destinations`
    );
  }

  if (!copiedCurrentShape.has("executions") &&
    tableExists(database, "chat_attention_receipts")) {
    const source = rowCount(database, "chat_attention_receipts");
    const target = scalarCount(database, `
      SELECT COALESCE(SUM(json_array_length(receipt_json, '$.receipts')), 0) AS count
      FROM executions
      WHERE json_extract(receipt_json, '$.schema') = 'ChatAttentionReceiptList@1'
    `);
    if (source !== target) {
      throw new Error(`Local database migration did not preserve Chat attention receipts`);
    }
  }
  if (!copiedCurrentShape.has("executions") &&
    tableExists(database, "chat_decision_receipts")) {
    const source = rowCount(database, "chat_decision_receipts");
    const target = scalarCount(database, `
      SELECT COUNT(*) AS count
      FROM executions
      WHERE json_extract(receipt_json, '$.schema') = 'ChatDecisionReceipt@1'
    `);
    if (source !== target) {
      throw new Error(`Local database migration did not preserve Chat decision receipts`);
    }
  }
  if (!copiedCurrentShape.has("reviews") &&
    tableExists(database, "review_transitions")) {
    const source = rowCount(database, "review_transitions");
    const target = scalarCount(database, `
      SELECT COALESCE(SUM(json_array_length(transitions_json)), 0) AS count
      FROM reviews
    `);
    if (source !== target) {
      throw new Error(`Local database migration did not preserve Review transitions`);
    }
  }
  if (tableExists(database, "notice_states")) {
    const source = rowCount(database, "notice_states");
    const matched = scalarCount(database, `
      SELECT COUNT(*) AS count
      FROM notice_states AS state
      JOIN notice_index AS projection ON projection.notice_id = state.notice_id
    `);
    if (source !== matched) {
      throw new Error(`Local database migration found Notice state without a projection`);
    }
  }
  const chatEventCount = scalarCount(database, `
    SELECT COUNT(*) AS count FROM events WHERE type = 'chat.message'
  `);
  const chatProjectionCount = rowCount(database, "chat_messages");
  if (chatEventCount !== chatProjectionCount) {
    throw new Error(
      `Local database migration did not project Chat messages: ` +
      `${chatEventCount} -> ${chatProjectionCount}`
    );
  }
}

function copyLegacyData(
  database: DatabaseSync,
  renamed: ReadonlyMap<string, string>
): ReadonlySet<string> {
  const copiedCurrentShape = copyCurrentShapeData(database, renamed);
  const oldFoundation = renamed.get("local_foundation");
  if (!copiedCurrentShape.has("local_foundation") &&
    oldFoundation !== undefined &&
    tableExists(database, "local_principals")) {
    database.exec(`
      INSERT INTO local_foundation (
        singleton, device_id, device_name, workspace_path, topic_id, topic_handle,
        owner_principal_id, owner_handle, owner_status, owner_created_at,
        owner_updated_at, created_at
      )
      SELECT
        foundation.singleton, foundation.device_id, foundation.device_name,
        foundation.workspace_path, foundation.topic_id, foundation.topic_handle,
        owner.principal_id, owner.handle, owner.status, owner.created_at,
        owner.updated_at, foundation.created_at
      FROM "${oldFoundation}" AS foundation
      JOIN local_principals AS owner
        ON owner.principal_id = foundation.owner_principal_id
      WHERE owner.kind = 'owner';
    `);
  }

  const oldSessions = renamed.get("agent_sessions") ??
    (tableExists(database, "sessions") ? "sessions" : undefined);
  if (!copiedCurrentShape.has("agent_sessions") && oldSessions !== undefined) {
    database.exec(`
      INSERT INTO agent_sessions (
        session_id, agent_id, run_id, adapter_id, provider_session_id, workspace,
        created_at, updated_at
      )
      SELECT session_id, agent_id, NULL, adapter_id, provider_session_id, workspace,
        created_at, updated_at
      FROM "${oldSessions}";
    `);
  }

  if (!copiedCurrentShape.has("agents") &&
    tableExists(database, "local_principals") &&
    tableExists(database, "local_agent_profiles")) {
    const pointerJoin = tableExists(database, "local_agent_sessions")
      ? `LEFT JOIN local_agent_sessions AS pointer
          ON pointer.principal_id = principal.principal_id`
      : "";
    const pointerId = tableExists(database, "local_agent_sessions")
      ? "pointer.current_session_id"
      : "NULL";
    const generation = tableExists(database, "local_agent_sessions")
      ? "COALESCE(pointer.generation, 1)"
      : "1";
    database.exec(`
      INSERT INTO agents (
        principal_id, handle, handle_key, status, agent_client, execution_config,
        current_session_id, session_generation, created_at, updated_at
      )
      SELECT
        principal.principal_id, principal.handle, principal.handle_key,
        principal.status, profile.agent_client, profile.execution_config,
        ${pointerId}, ${generation}, principal.created_at, principal.updated_at
      FROM local_principals AS principal
      JOIN local_agent_profiles AS profile
        ON profile.principal_id = principal.principal_id
      ${pointerJoin}
      WHERE principal.kind = 'agent';
    `);
  }

  const oldEvents = renamed.get("events");
  if (!copiedCurrentShape.has("events") && oldEvents !== undefined) {
    const destinationSnapshots = tableExists(database, "destinations")
      ? `COALESCE((
          SELECT json_group_array(json_object(
            'destinationId', destination.destination_id,
            'kind', destination.kind,
            'address', json(destination.address_json),
            'createdAt', destination.created_at,
            'updatedAt', destination.updated_at
          ))
          FROM json_each(event.destination_ids_json) AS requested
          JOIN destinations AS destination
            ON destination.destination_id = requested.value
        ), '[]')`
      : "'[]'";
    database.exec(`
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
        created_at
      )
      SELECT
        event.event_id, event.type, event.source_kind, event.source_external_id,
        event.agent_id, event.prompt, event.outcome, event.output, event.error,
        event.payload_json, event.session_id, event.destination_ids_json,
        ${destinationSnapshots}, event.root_event_id, event.parent_event_id,
        event.causal_hop, event.created_at
      FROM "${oldEvents}" AS event;
    `);
  }

  const oldExecutions = renamed.get("executions");
  if (!copiedCurrentShape.has("executions") && oldExecutions !== undefined) {
    database.exec(`
      INSERT INTO executions (
        execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, last_error, receipt_json, created_at, started_at,
        completed_at, updated_at
      )
      SELECT execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, last_error, NULL, created_at, started_at, completed_at,
        updated_at
      FROM "${oldExecutions}";
    `);
    migrateChatReceipts(database);
  }

  const oldDeliveries = renamed.get("deliveries");
  if (!copiedCurrentShape.has("deliveries") &&
    oldDeliveries !== undefined &&
    tableExists(database, "destinations")) {
    database.exec(`
      INSERT INTO deliveries (
        delivery_id, result_event_id, destination_id, destination_kind,
        destination_address_json, status, attempt_count, max_attempts,
        next_attempt_at, receipt, last_error, created_at, updated_at
      )
      SELECT
        delivery.delivery_id, delivery.result_event_id, delivery.destination_id,
        destination.kind, destination.address_json, delivery.status,
        delivery.attempt_count, delivery.max_attempts, delivery.next_attempt_at,
        delivery.receipt, delivery.last_error, delivery.created_at,
        delivery.updated_at
      FROM "${oldDeliveries}" AS delivery
      JOIN destinations AS destination
        ON destination.destination_id = delivery.destination_id;
    `);
  }

  if (!copiedCurrentShape.has("chat_presence") &&
    tableExists(database, "chat_agent_presence")) {
    database.exec(`
      INSERT INTO chat_presence
      SELECT * FROM chat_agent_presence;
    `);
  }

  if (!copiedCurrentShape.has("subscriptions") &&
    tableExists(database, "poll_subscriptions")) {
    database.exec(`
      INSERT INTO subscriptions (
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count,
        callback_provider_session_id, callback_adapter_id, callback_workspace,
        callback_session_id, callback_prompt, status, started_at, deadline_at,
        next_poll_at, latest_error, fire_event_id, created_at, updated_at
      )
      SELECT
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count,
        callback_provider_session_id, callback_adapter_id, callback_workspace,
        callback_session_id, callback_prompt, status, started_at, deadline_at,
        next_poll_at, latest_error, fire_event_id, created_at, updated_at
      FROM poll_subscriptions;
    `);
  }

  if (!copiedCurrentShape.has("schedules") &&
    tableExists(database, "schedule_definitions") &&
    tableExists(database, "schedule_revisions")) {
    database.exec(`
      INSERT INTO schedules (
        schedule_id, owner_principal_id, status, current_revision, next_run_at,
        next_occurrence_key, next_occurrence_missing, agent_id, kind, expression,
        expression_version, timezone, misfire_policy, overlap_policy,
        misfire_grace_ms, session_policy, fixed_session_id, prompt, workspace,
        revision_created_at, created_at, updated_at
      )
      SELECT
        definition.schedule_id, definition.owner_principal_id, definition.status,
        definition.current_revision, definition.next_run_at,
        definition.next_occurrence_key, definition.next_occurrence_missing,
        revision.agent_id, revision.kind, revision.expression,
        revision.expression_version, revision.timezone, revision.misfire_policy,
        revision.overlap_policy, revision.misfire_grace_ms,
        revision.session_policy, revision.fixed_session_id, revision.prompt,
        revision.workspace, revision.created_at, definition.created_at,
        definition.updated_at
      FROM schedule_definitions AS definition
      JOIN schedule_revisions AS revision
        ON revision.schedule_id = definition.schedule_id
       AND revision.revision = definition.current_revision;
    `);
  }

  const oldRuns = renamed.get("scheduled_runs");
  if (!copiedCurrentShape.has("scheduled_runs") && oldRuns !== undefined) {
    const snapshot = tableExists(database, "schedule_revisions")
      ? `COALESCE((
          SELECT json_object(
            'schema', 'ScheduleDefinitionSnapshot@1',
            'scheduleId', revision.schedule_id,
            'revision', revision.revision,
            'agentId', revision.agent_id,
            'kind', revision.kind,
            'expression', revision.expression,
            'expressionVersion', revision.expression_version,
            'timezone', revision.timezone,
            'misfirePolicy', revision.misfire_policy,
            'overlapPolicy', revision.overlap_policy,
            'misfireGraceMilliseconds', revision.misfire_grace_ms,
            'sessionPolicy', revision.session_policy,
            'fixedSessionId', revision.fixed_session_id,
            'prompt', revision.prompt,
            'workspace', revision.workspace,
            'createdAt', revision.created_at
          )
          FROM schedule_revisions AS revision
          WHERE revision.schedule_id = run.schedule_id
            AND revision.revision = run.schedule_revision
        ), '{}')`
      : "'{}'";
    database.exec(`
      INSERT INTO scheduled_runs (
        run_id, schedule_id, occurrence_key, scheduled_for, schedule_revision,
        definition_snapshot_json, coalesced_through, admitted_at, status,
        event_id, execution_id, session_id, decision_reason, created_at,
        updated_at, completed_at
      )
      SELECT
        run_id, schedule_id, occurrence_key, scheduled_for, schedule_revision,
        ${snapshot}, coalesced_through, admitted_at, status, event_id,
        execution_id, session_id, decision_reason, created_at, updated_at,
        completed_at
      FROM "${oldRuns}" AS run;
    `);
  }

  if (!copiedCurrentShape.has("reviews") &&
    tableExists(database, "review_chains")) {
    database.exec(`
      INSERT INTO reviews (
        root_event_id, subject_ref, workspace_ref, phase, cycle_index,
        expected_event_id, active_execution_id, subject_revision,
        artifact_revision, implementation_revision, rework_count, rework_limit,
        terminal_decision, terminal_reason, reviewer_session_id,
        implementer_session_id, transitions_json, updated_at
      )
      SELECT
        chain.root_event_id, chain.subject_ref, chain.workspace_ref, chain.phase,
        chain.cycle_index, chain.expected_event_id, chain.active_execution_id,
        chain.subject_revision, chain.artifact_revision,
        chain.implementation_revision, chain.rework_count, chain.rework_limit,
        chain.terminal_decision, chain.terminal_reason,
        ${roleSessionSql("reviewer")},
        ${roleSessionSql("implementer")},
        ${reviewTransitionsSql()},
        chain.updated_at
      FROM review_chains AS chain;
    `);
  }

  if (!copiedCurrentShape.has("notices") &&
    tableExists(database, "notice_index")) {
    const stateJoin = tableExists(database, "notice_states")
      ? "LEFT JOIN notice_states AS state ON state.notice_id = projection.notice_id"
      : "";
    const readAt = tableExists(database, "notice_states") ? "state.read_at" : "NULL";
    const acknowledgedAt = tableExists(database, "notice_states")
      ? "state.acknowledged_at"
      : "NULL";
    const stateUpdatedAt = tableExists(database, "notice_states")
      ? "state.updated_at"
      : "NULL";
    database.exec(`
      INSERT INTO notices (
        notice_id, source_kind, source_id, title, summary, outcome,
        delivery_status, delivery_error, event_id, destination_id,
        subscription_id, occurred_at, delivered_at, projection_updated_at,
        read_at, acknowledged_at, state_updated_at
      )
      SELECT
        projection.notice_id, projection.source_kind, projection.source_id,
        projection.title, projection.summary, projection.outcome,
        projection.delivery_status, projection.delivery_error,
        projection.event_id, projection.destination_id,
        projection.subscription_id, projection.occurred_at,
        projection.delivered_at, projection.projection_updated_at,
        ${readAt}, ${acknowledgedAt}, ${stateUpdatedAt}
      FROM notice_index AS projection
      ${stateJoin}
      WHERE 1
      ON CONFLICT(source_kind, source_id) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        outcome = excluded.outcome,
        delivery_status = excluded.delivery_status,
        delivery_error = excluded.delivery_error,
        event_id = excluded.event_id,
        destination_id = excluded.destination_id,
        subscription_id = excluded.subscription_id,
        occurred_at = excluded.occurred_at,
        delivered_at = excluded.delivered_at,
        projection_updated_at = excluded.projection_updated_at,
        read_at = excluded.read_at,
        acknowledged_at = excluded.acknowledged_at,
        state_updated_at = excluded.state_updated_at;
    `);
  }
  return copiedCurrentShape;
}

function copyCurrentShapeData(
  database: DatabaseSync,
  renamed: ReadonlyMap<string, string>
): ReadonlySet<string> {
  const copied = new Set<string>();
  for (const table of TARGET_TABLES) {
    if (table === "schema_meta") continue;
    const source = renamed.get(table);
    if (source === undefined) continue;
    const targetColumns = tableColumns(database, table);
    const sourceColumns = new Set(tableColumns(database, source));
    if (!targetColumns.every((column) => sourceColumns.has(column))) continue;
    if (rowCount(database, source) === 0 && legacyRowCount(database, table) > 0) {
      continue;
    }
    const columns = targetColumns.map(quoteIdentifier).join(", ");
    database.exec(`
      INSERT INTO ${quoteIdentifier(table)} (${columns})
      SELECT ${columns}
      FROM ${quoteIdentifier(source)};
    `);
    copied.add(table);
  }
  return copied;
}

function backfillChatMessages(database: DatabaseSync): void {
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

function legacyRowCount(database: DatabaseSync, target: string): number {
  const source = {
    agent_sessions: "sessions",
    agents: "local_agent_profiles",
    chat_presence: "chat_agent_presence",
    notices: "notice_index",
    reviews: "review_chains",
    schedules: "schedule_definitions",
    subscriptions: "poll_subscriptions"
  }[target];
  return source !== undefined && tableExists(database, source)
    ? rowCount(database, source)
    : 0;
}

function migrateChatReceipts(database: DatabaseSync): void {
  if (tableExists(database, "chat_attention_receipts")) {
    const rows = database.prepare(`
      SELECT DISTINCT source_message_event_id
      FROM chat_attention_receipts
    `).all() as unknown as Array<{ source_message_event_id: string }>;
    const update = database.prepare(`
      UPDATE executions
      SET receipt_json = ?
      WHERE event_id = ?
    `);
    const receipts = database.prepare(`
      SELECT source_message_event_id, agent_id, outcome, reason,
        presence_snapshot_json, dispatch_event_id, prompt_resource_id, created_at
      FROM chat_attention_receipts
      WHERE source_message_event_id = ?
      ORDER BY created_at, agent_id
    `);
    for (const row of rows) {
      const values = receipts.all(row.source_message_event_id) as unknown as Array<{
        source_message_event_id: string;
        agent_id: string;
        outcome: "dispatched" | "skipped";
        reason: string;
        presence_snapshot_json: string;
        dispatch_event_id: string | null;
        prompt_resource_id: string | null;
        created_at: string;
      }>;
      update.run(JSON.stringify({
        schema: "ChatAttentionReceiptList@1",
        receipts: values.map((value) => ({
          sourceMessageEventId: value.source_message_event_id,
          agentId: value.agent_id,
          outcome: value.outcome,
          reason: value.reason,
          presenceSnapshot: JSON.parse(value.presence_snapshot_json) as unknown,
          ...(value.dispatch_event_id === null
            ? {}
            : { dispatchEventId: value.dispatch_event_id }),
          ...(value.prompt_resource_id === null
            ? {}
            : { promptResourceId: value.prompt_resource_id }),
          createdAt: value.created_at
        }))
      }), row.source_message_event_id);
    }
  }
  if (tableExists(database, "chat_decision_receipts")) {
    const rows = database.prepare(`
      SELECT dispatch_event_id, speech_action, presence_transition_json,
        reply_event_id, created_at
      FROM chat_decision_receipts
    `).all() as unknown as Array<{
      dispatch_event_id: string;
      speech_action: "reply" | "silent";
      presence_transition_json: string;
      reply_event_id: string | null;
      created_at: string;
    }>;
    const update = database.prepare(`
      UPDATE executions SET receipt_json = ? WHERE event_id = ?
    `);
    for (const row of rows) {
      const presence = JSON.parse(row.presence_transition_json) as unknown;
      update.run(JSON.stringify({
        schema: "ChatDecisionReceipt@1",
        dispatchEventId: row.dispatch_event_id,
        speechAction: row.speech_action,
        ...(presence === null ? {} : { presenceTransition: presence }),
        ...(row.reply_event_id === null ? {} : { replyEventId: row.reply_event_id }),
        createdAt: row.created_at
      }), row.dispatch_event_id);
    }
  }
}

function roleSessionSql(role: "reviewer" | "implementer"): string {
  return `(SELECT session_id FROM review_role_sessions
    WHERE root_event_id = chain.root_event_id AND role = '${role}')`;
}

function reviewTransitionsSql(): string {
  return `COALESCE((
    SELECT json_group_array(json_object(
      'phase', transition.phase,
      'cycleIndex', transition.cycle_index,
      'parentEventId', transition.parent_event_id,
      'childEventId', transition.child_event_id,
      'childExecutionId', transition.child_execution_id,
      'createdAt', transition.created_at
    ))
    FROM review_transitions AS transition
    WHERE transition.root_event_id = chain.root_event_id
    ORDER BY transition.cycle_index, transition.phase
  ), '[]')`;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT REFERENCES agent_runs(run_id),
      adapter_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(adapter_id, provider_session_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_run_agent
      ON agent_sessions(run_id, agent_id) WHERE run_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS local_foundation (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      device_id TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      topic_id TEXT NOT NULL UNIQUE,
      topic_handle TEXT NOT NULL UNIQUE CHECK(topic_handle = 'local'),
      owner_principal_id TEXT NOT NULL UNIQUE,
      owner_handle TEXT NOT NULL,
      owner_status TEXT NOT NULL CHECK(owner_status IN ('active', 'suspended')),
      owner_created_at TEXT NOT NULL,
      owner_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      principal_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      handle_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('active', 'suspended')),
      agent_client TEXT NOT NULL
        CHECK(agent_client IN ('codex', 'claude-code', 'kimi-code')),
      execution_config TEXT NOT NULL CHECK(json_valid(execution_config)),
      current_session_id TEXT REFERENCES agent_sessions(session_id),
      session_generation INTEGER NOT NULL DEFAULT 1 CHECK(session_generation >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN (
        'agent.request', 'subscription.fire', 'agent.result',
        'review.requested', 'review.decision',
        'chat.message', 'chat.dispatch'
      )),
      source_kind TEXT NOT NULL CHECK(source_kind IN (
        'cli', 'subscription', 'schedule', 'matrix', 'server', 'handler'
      )),
      source_external_id TEXT,
      agent_id TEXT,
      prompt TEXT,
      outcome TEXT CHECK(outcome IN ('succeeded', 'failed')),
      output TEXT,
      error TEXT,
      payload_json TEXT,
      session_id TEXT REFERENCES agent_sessions(session_id),
      destination_ids_json TEXT NOT NULL CHECK(json_valid(destination_ids_json)),
      destination_snapshots_json TEXT NOT NULL CHECK(
        json_valid(destination_snapshots_json)
        AND length(destination_snapshots_json) <= 65536
      ),
      root_event_id TEXT NOT NULL,
      parent_event_id TEXT,
      causal_hop INTEGER NOT NULL CHECK(causal_hop >= 0),
      created_at TEXT NOT NULL,
      CHECK(
        (type = 'agent.request' AND agent_id IS NOT NULL
          AND prompt IS NOT NULL AND outcome IS NULL AND output IS NULL
          AND error IS NULL AND (payload_json IS NULL OR json_valid(payload_json)))
        OR
        (type = 'subscription.fire' AND agent_id IS NOT NULL
          AND prompt IS NOT NULL AND outcome IS NULL AND output IS NULL
          AND error IS NULL AND (payload_json IS NULL OR json_valid(payload_json)))
        OR
        (type = 'agent.result' AND agent_id IS NOT NULL AND prompt IS NULL
          AND outcome IS NOT NULL
          AND (payload_json IS NULL OR json_valid(payload_json))
          AND ((outcome = 'succeeded' AND output IS NOT NULL AND error IS NULL)
            OR (outcome = 'failed' AND output IS NULL AND error IS NOT NULL)))
        OR
        (type IN ('review.requested', 'review.decision') AND agent_id IS NULL
          AND prompt IS NULL AND outcome IS NULL AND output IS NULL
          AND error IS NULL AND payload_json IS NOT NULL AND json_valid(payload_json))
        OR
        (type = 'chat.message' AND prompt IS NULL AND outcome IS NULL
          AND output IS NULL AND error IS NULL AND payload_json IS NOT NULL
          AND json_valid(payload_json))
        OR
        (type = 'chat.dispatch' AND agent_id IS NOT NULL AND prompt IS NOT NULL
          AND outcome IS NULL AND output IS NULL AND error IS NULL
          AND payload_json IS NOT NULL AND json_valid(payload_json))
      ),
      UNIQUE(source_kind, source_external_id)
    );
    CREATE INDEX IF NOT EXISTS events_causal
      ON events(root_event_id, causal_hop, created_at);
    CREATE INDEX IF NOT EXISTS events_chat_topic_cursor
      ON events(
        json_extract(payload_json, '$.topicId'),
        created_at DESC,
        event_id DESC
      )
      WHERE type = 'chat.message';
    CREATE TABLE IF NOT EXISTS executions (
      execution_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      handler TEXT NOT NULL CHECK(handler IN (
        'agent', 'result', 'review', 'chat'
      )),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'
      )),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      receipt_json TEXT CHECK(receipt_json IS NULL OR (
        json_valid(receipt_json) AND length(receipt_json) <= 65536
      )),
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS executions_due
      ON executions(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      root_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      owner_request_id TEXT NOT NULL UNIQUE,
      owner_principal_id TEXT NOT NULL,
      steward_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
      mandate_snapshot_json TEXT NOT NULL CHECK(
        json_valid(mandate_snapshot_json)
        AND length(mandate_snapshot_json) <= 65536
      ),
      workspace_grant_json TEXT CHECK(
        workspace_grant_json IS NULL OR (
          json_valid(workspace_grant_json)
          AND length(workspace_grant_json) <= 16384
        )
      ),
      status TEXT NOT NULL CHECK(status IN (
        'active', 'waiting', 'succeeded', 'failed', 'needs_human', 'cancelled'
      )),
      active_step_id TEXT,
      active_execution_id TEXT REFERENCES executions(execution_id),
      step_count INTEGER NOT NULL CHECK(step_count >= 1),
      max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 1000),
      max_depth INTEGER NOT NULL CHECK(max_depth BETWEEN 0 AND 100),
      deadline_at TEXT,
      terminal_summary TEXT,
      cancelled_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (
          status IN ('active', 'waiting')
          AND active_step_id IS NOT NULL
          AND active_execution_id IS NOT NULL
          AND terminal_summary IS NULL
          AND cancelled_at IS NULL
        )
        OR
        (
          status IN ('succeeded', 'failed', 'needs_human')
          AND active_step_id IS NULL
          AND active_execution_id IS NULL
          AND terminal_summary IS NOT NULL
          AND cancelled_at IS NULL
        )
        OR
        (
          status = 'cancelled'
          AND active_step_id IS NULL
          AND active_execution_id IS NULL
          AND terminal_summary IS NOT NULL
          AND cancelled_at IS NOT NULL
        )
      )
    );
    CREATE INDEX IF NOT EXISTS agent_runs_status_updated
      ON agent_runs(status, updated_at DESC, run_id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_active_write_workspace
      ON agent_runs(json_extract(workspace_grant_json, '$.root'))
      WHERE status IN ('active', 'waiting')
        AND json_extract(workspace_grant_json, '$.access') = 'write';
    CREATE TABLE IF NOT EXISTS chat_messages (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      topic_id TEXT NOT NULL,
      sender_kind TEXT NOT NULL CHECK(sender_kind IN ('owner', 'agent', 'system')),
      sender_principal_id TEXT,
      sender_handle_snapshot TEXT NOT NULL,
      body TEXT NOT NULL,
      target_principal_id TEXT,
      target_handle_snapshot TEXT,
      created_at TEXT NOT NULL,
      attention_json TEXT CHECK(
        attention_json IS NULL OR (
          json_valid(attention_json) AND length(attention_json) <= 65536
        )
      ),
      read_progress_json TEXT CHECK(
        read_progress_json IS NULL OR (
          json_valid(read_progress_json) AND length(read_progress_json) <= 65536
        )
      ),
      projected_at TEXT NOT NULL,
      CHECK(
        (target_principal_id IS NULL AND target_handle_snapshot IS NULL)
        OR (target_principal_id IS NOT NULL AND target_handle_snapshot IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS chat_messages_topic_cursor
      ON chat_messages(topic_id, created_at DESC, event_id DESC);
    CREATE TRIGGER IF NOT EXISTS chat_message_project_event_insert
    AFTER INSERT ON events
    WHEN NEW.type = 'chat.message'
    BEGIN
      INSERT INTO chat_messages (
        event_id, topic_id, sender_kind, sender_principal_id,
        sender_handle_snapshot, body, target_principal_id,
        target_handle_snapshot, created_at, projected_at
      ) VALUES (
        NEW.event_id,
        json_extract(NEW.payload_json, '$.topicId'),
        json_extract(NEW.payload_json, '$.sender.kind'),
        json_extract(NEW.payload_json, '$.sender.principalId'),
        json_extract(NEW.payload_json, '$.sender.handleSnapshot'),
        json_extract(NEW.payload_json, '$.body'),
        json_extract(NEW.payload_json, '$.target.principalId'),
        json_extract(NEW.payload_json, '$.target.handleSnapshot'),
        NEW.created_at,
        NEW.created_at
      )
      ON CONFLICT(event_id) DO NOTHING;
    END;
    CREATE VIEW IF NOT EXISTS chat_message_read_progress_v1 AS
    SELECT
      state.event_id,
      json_object(
        'schema', 'ChatReadProgress@1',
        'total', COUNT(*),
        'read', COALESCE(SUM(CASE WHEN state.read_state = 'read' THEN 1 ELSE 0 END), 0),
        'agents', json_group_array(json_object(
          'agentId', state.agent_id,
          'handleSnapshot', state.handle_snapshot,
          'state', state.read_state,
          'reason', state.reason,
          'failureReason', state.failure_reason
        ))
      ) AS progress_json
    FROM (
      SELECT
        message.event_id,
        CAST(receipt.key AS INTEGER) AS receipt_index,
        json_extract(receipt.value, '$.agentId') AS agent_id,
        COALESCE(
          json_extract(receipt.value, '$.handleSnapshot'),
          agent.handle,
          json_extract(receipt.value, '$.agentId')
        ) AS handle_snapshot,
        json_extract(receipt.value, '$.reason') AS reason,
        CASE
          WHEN dispatch_execution.status = 'failed'
          THEN dispatch_execution.last_error
          ELSE NULL
        END AS failure_reason,
        CASE
          WHEN json_extract(receipt.value, '$.outcome') = 'skipped' THEN 'unread'
          WHEN dispatch_execution.status = 'succeeded' THEN 'read'
          WHEN dispatch_execution.status = 'failed' THEN 'failed'
          ELSE 'reading'
        END AS read_state
      FROM chat_messages AS message
      JOIN json_each(message.attention_json, '$.receipts') AS receipt
      LEFT JOIN agents AS agent
        ON agent.principal_id = json_extract(receipt.value, '$.agentId')
      LEFT JOIN executions AS dispatch_execution
        ON dispatch_execution.event_id =
          json_extract(receipt.value, '$.dispatchEventId')
      WHERE json_extract(receipt.value, '$.reason') != 'agent-suspended'
      ORDER BY message.event_id, CAST(receipt.key AS INTEGER)
    ) AS state
    GROUP BY state.event_id;
    CREATE TRIGGER IF NOT EXISTS chat_message_project_read_progress_attention
    AFTER UPDATE OF receipt_json ON executions
    WHEN EXISTS (
      SELECT 1 FROM events
      WHERE event_id = NEW.event_id AND type = 'chat.message'
    )
    BEGIN
      UPDATE chat_messages
      SET attention_json = CASE
          WHEN json_extract(NEW.receipt_json, '$.schema') =
            'ChatAttentionReceiptList@1'
          THEN NEW.receipt_json
          ELSE attention_json
        END
      WHERE event_id = NEW.event_id;
      UPDATE chat_messages
      SET read_progress_json = (
          SELECT progress_json
          FROM chat_message_read_progress_v1
          WHERE event_id = NEW.event_id
        ),
        projected_at = NEW.updated_at
      WHERE event_id = NEW.event_id;
    END;
    CREATE TRIGGER IF NOT EXISTS chat_message_project_read_progress_dispatch
    AFTER UPDATE OF status, receipt_json ON executions
    WHEN EXISTS (
      SELECT 1 FROM events
      WHERE event_id = NEW.event_id AND type = 'chat.dispatch'
    )
    BEGIN
      UPDATE chat_messages
      SET read_progress_json = (
          SELECT progress_json
          FROM chat_message_read_progress_v1
          WHERE event_id = json_extract(
            (SELECT payload_json FROM events WHERE event_id = NEW.event_id),
            '$.sourceMessageEventId'
          )
        ),
        projected_at = NEW.updated_at
      WHERE event_id = json_extract(
        (SELECT payload_json FROM events WHERE event_id = NEW.event_id),
        '$.sourceMessageEventId'
      );
    END;
    CREATE TABLE IF NOT EXISTS deliveries (
      delivery_id TEXT PRIMARY KEY,
      result_event_id TEXT NOT NULL REFERENCES events(event_id),
      destination_id TEXT NOT NULL,
      destination_kind TEXT NOT NULL CHECK(destination_kind IN (
        'matrix', 'macos-notification'
      )),
      destination_address_json TEXT NOT NULL CHECK(json_valid(destination_address_json)),
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'delivering', 'retry_wait', 'delivered', 'failed'
      )),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
      next_attempt_at TEXT NOT NULL,
      receipt TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(result_event_id, destination_id)
    );
    CREATE INDEX IF NOT EXISTS deliveries_due
      ON deliveries(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS chat_presence (
      agent_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('topic', 'global')),
      scope_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('available', 'snoozed')),
      until_at TEXT,
      wake_keywords_json TEXT NOT NULL CHECK(json_valid(wake_keywords_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      updated_by_dispatch_event_id TEXT REFERENCES events(event_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, scope_kind, scope_id),
      CHECK(
        (scope_kind = 'global' AND scope_id = '*')
        OR (scope_kind = 'topic' AND scope_id <> '*')
      ),
      CHECK(
        (mode = 'available' AND until_at IS NULL)
        OR (mode = 'snoozed' AND until_at IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      subscription_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
      plugin_path TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_schema_version INTEGER NOT NULL CHECK(plugin_schema_version = 1),
      plugin_config_json TEXT NOT NULL CHECK(json_valid(plugin_config_json)),
      policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
      interval_ms INTEGER NOT NULL,
      max_wait_ms INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      callback_provider_session_id TEXT NOT NULL,
      callback_adapter_id TEXT NOT NULL,
      callback_workspace TEXT NOT NULL,
      callback_session_id TEXT REFERENCES agent_sessions(session_id),
      callback_prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'active', 'paused', 'completed', 'cancelled', 'expired'
      )),
      started_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      next_poll_at TEXT NOT NULL,
      latest_error TEXT,
      fire_event_id TEXT UNIQUE REFERENCES events(event_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subscriptions_due
      ON subscriptions(status, next_poll_at);
    CREATE TABLE IF NOT EXISTS schedules (
      schedule_id TEXT PRIMARY KEY,
      owner_principal_id TEXT NOT NULL REFERENCES agents(principal_id),
      status TEXT NOT NULL CHECK(status IN (
        'active', 'paused', 'completed', 'cancelled'
      )),
      current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
      next_run_at TEXT,
      next_occurrence_key TEXT,
      next_occurrence_missing INTEGER NOT NULL DEFAULT 0
        CHECK(next_occurrence_missing IN (0, 1)),
      agent_id TEXT NOT NULL REFERENCES agents(principal_id),
      kind TEXT NOT NULL CHECK(kind IN ('once', 'cron')),
      expression TEXT NOT NULL,
      expression_version TEXT NOT NULL CHECK(
        expression_version IN ('once-rfc3339-v1', 'cron-v1')
      ),
      timezone TEXT,
      misfire_policy TEXT NOT NULL CHECK(misfire_policy IN ('skip', 'run_once')),
      overlap_policy TEXT NOT NULL CHECK(overlap_policy IN ('skip', 'queue')),
      misfire_grace_ms INTEGER NOT NULL CHECK(
        misfire_grace_ms BETWEEN 0 AND 604800000
      ),
      session_policy TEXT NOT NULL CHECK(session_policy IN ('new_each_run', 'fixed')),
      fixed_session_id TEXT REFERENCES agent_sessions(session_id),
      prompt TEXT NOT NULL,
      workspace TEXT NOT NULL,
      revision_created_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (next_run_at IS NULL AND next_occurrence_key IS NULL)
        OR (next_run_at IS NOT NULL AND next_occurrence_key IS NOT NULL)
      ),
      CHECK(
        (kind = 'once' AND expression_version = 'once-rfc3339-v1' AND timezone IS NULL)
        OR (kind = 'cron' AND expression_version = 'cron-v1' AND timezone IS NOT NULL)
      ),
      CHECK(
        (session_policy = 'new_each_run' AND fixed_session_id IS NULL)
        OR (session_policy = 'fixed' AND fixed_session_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS schedules_due
      ON schedules(status, next_run_at);
    CREATE TABLE IF NOT EXISTS scheduled_runs (
      run_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL,
      definition_snapshot_json TEXT NOT NULL CHECK(
        json_valid(definition_snapshot_json)
        AND length(definition_snapshot_json) <= 131072
      ),
      coalesced_through TEXT,
      admitted_at TEXT,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'succeeded', 'failed', 'skipped', 'unknown'
      )),
      event_id TEXT UNIQUE REFERENCES events(event_id),
      execution_id TEXT UNIQUE REFERENCES executions(execution_id),
      session_id TEXT REFERENCES agent_sessions(session_id),
      decision_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(schedule_id, occurrence_key)
    );
    CREATE INDEX IF NOT EXISTS scheduled_runs_schedule
      ON scheduled_runs(schedule_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS scheduled_runs_status
      ON scheduled_runs(schedule_id, status, created_at);
    CREATE TABLE IF NOT EXISTS reviews (
      root_event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      subject_ref TEXT NOT NULL,
      workspace_ref TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('reviewing', 'implementing', 'terminal')),
      cycle_index INTEGER NOT NULL CHECK(cycle_index >= 0),
      expected_event_id TEXT NOT NULL REFERENCES events(event_id),
      active_execution_id TEXT REFERENCES executions(execution_id),
      subject_revision TEXT NOT NULL,
      artifact_revision TEXT,
      implementation_revision TEXT NOT NULL,
      rework_count INTEGER NOT NULL CHECK(rework_count >= 0),
      rework_limit INTEGER NOT NULL CHECK(rework_limit BETWEEN 0 AND 20),
      terminal_decision TEXT CHECK(terminal_decision IN ('passed', 'blocked')),
      terminal_reason TEXT,
      reviewer_session_id TEXT REFERENCES agent_sessions(session_id),
      implementer_session_id TEXT REFERENCES agent_sessions(session_id),
      transitions_json TEXT NOT NULL DEFAULT '[]' CHECK(
        json_valid(transitions_json) AND length(transitions_json) <= 65536
      ),
      updated_at TEXT NOT NULL,
      CHECK(
        reviewer_session_id IS NULL OR implementer_session_id IS NULL
        OR reviewer_session_id <> implementer_session_id
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_active_subject
      ON reviews(subject_ref) WHERE phase != 'terminal';
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_active_workspace
      ON reviews(workspace_ref) WHERE phase != 'terminal';
    CREATE TABLE IF NOT EXISTS notices (
      notice_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind = 'delivery'),
      source_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
      summary TEXT NOT NULL CHECK(length(summary) <= 4096),
      outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed')),
      delivery_status TEXT NOT NULL CHECK(delivery_status IN (
        'pending', 'delivering', 'retry_wait', 'delivered', 'failed'
      )),
      delivery_error TEXT CHECK(
        delivery_error IS NULL OR length(delivery_error) <= 512
      ),
      event_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      subscription_id TEXT,
      occurred_at TEXT NOT NULL,
      delivered_at TEXT,
      projection_updated_at TEXT NOT NULL,
      read_at TEXT,
      acknowledged_at TEXT,
      state_updated_at TEXT,
      UNIQUE(source_kind, source_id),
      CHECK(acknowledged_at IS NULL OR read_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS notices_timeline
      ON notices(occurred_at DESC, notice_id DESC);
    CREATE TRIGGER IF NOT EXISTS notice_project_delivery_insert
    AFTER INSERT ON deliveries
    BEGIN
      ${noticeProjectionSql("NEW.delivery_id")}
    END;
    CREATE TRIGGER IF NOT EXISTS notice_project_delivery_update
    AFTER UPDATE ON deliveries
    BEGIN
      ${noticeProjectionSql("NEW.delivery_id")}
    END;
  `);
}

function noticeProjectionSql(deliveryIdExpression: string): string {
  return `
    INSERT INTO notices (
      notice_id, source_kind, source_id, title, summary, outcome,
      delivery_status, delivery_error, event_id, destination_id,
      subscription_id, occurred_at, delivered_at, projection_updated_at
    )
    SELECT
      'ntc1_' || delivery.delivery_id,
      'delivery',
      delivery.delivery_id,
      substr(COALESCE(
        NULLIF(trim(json_extract(delivery.destination_address_json, '$.title')), ''),
        'Agent result'
      ), 1, 160),
      substr(COALESCE(event.output, event.error, ''), 1, 4096),
      event.outcome,
      delivery.status,
      CASE
        WHEN delivery.last_error IS NULL THEN NULL
        ELSE substr(delivery.last_error, 1, 512)
      END,
      event.event_id,
      delivery.destination_id,
      CASE
        WHEN json_type(delivery.destination_address_json, '$.subscriptionId') = 'text'
        THEN substr(
          json_extract(delivery.destination_address_json, '$.subscriptionId'),
          1,
          256
        )
        ELSE NULL
      END,
      event.created_at,
      CASE WHEN delivery.status = 'delivered' THEN delivery.updated_at ELSE NULL END,
      delivery.updated_at
    FROM deliveries AS delivery
    JOIN events AS event ON event.event_id = delivery.result_event_id
    WHERE delivery.delivery_id = ${deliveryIdExpression}
      AND delivery.destination_kind = 'macos-notification'
      AND event.type = 'agent.result'
    ON CONFLICT(source_kind, source_id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      outcome = excluded.outcome,
      delivery_status = excluded.delivery_status,
      delivery_error = excluded.delivery_error,
      event_id = excluded.event_id,
      destination_id = excluded.destination_id,
      subscription_id = excluded.subscription_id,
      occurred_at = excluded.occurred_at,
      delivered_at = excluded.delivered_at,
      projection_updated_at = excluded.projection_updated_at;
  `;
}

function writeSchemaVersion(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(LOCAL_SCHEMA_VERSION));
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table) !== undefined;
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(
    `PRAGMA table_info(${quoteIdentifier(table)})`
  ).all() as unknown as Array<{ name: string }>).map(({ name }) => name);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function schemaVersion(database: DatabaseSync): number | undefined {
  if (!tableExists(database, "schema_meta")) return undefined;
  const row = database.prepare(`
    SELECT value FROM schema_meta WHERE key = 'schema_version'
  `).get() as { value: string } | undefined;
  if (row === undefined) return undefined;
  const value = Number(row.value);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Local database schema version is invalid: ${row.value}`);
  }
  return value;
}

function productTables(database: DatabaseSync): string[] {
  return (database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map(({ name }) => name);
}

function rowCount(database: DatabaseSync, table: string): number {
  return scalarCount(database, `SELECT COUNT(*) AS count FROM "${table}"`);
}

function scalarCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count: number | bigint };
  return Number(row.count);
}
