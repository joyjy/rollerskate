import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import {
  assertSupportedSchemaShape,
  backfillChatMessages,
  dropChatProjectionObjects,
  hasAnyProductTable,
  migrateV44Schema,
  TARGET_TABLES
} from "./v44-migration.js";
import {
  productTables,
  rowCount,
  scalarCount,
  schemaVersion,
  tableColumns,
  writeSchemaVersion
} from "./introspection.js";
import {
  assertV53SchemaShape,
  migrateV53Schema
} from "./v53-migration.js";
import {
  assertV54SchemaShape,
  migrateV54Schema
} from "./v54-migration.js";
import { assertV55SchemaShape, migrateV55Schema } from "./v55-migration.js";
import { assertV56SchemaShape, migrateV56Schema } from "./v56-migration.js";
import {
  assertV57SchemaShape,
  migrateV57Schema
} from "./v57-migration.js";
import {
  assertV58SchemaShape,
  hasSupportedLegacyReleaseCandidateTables,
  LEGACY_RELEASE_CANDIDATE_TABLES,
  migrateV58Schema
} from "./v58-migration.js";
import { assertV59SchemaShape, migrateV59Schema } from "./v59-migration.js";
import { assertV60SchemaShape, migrateV60Schema } from "./v60-migration.js";
import {
  assertV61SchemaShape,
  hasInitialStewardRunShape,
  hasVikunjaTaskDeliveryKind,
  migrateV61Schema
} from "./v61-migration.js";
import { assertV62SchemaShape, migrateV62Schema } from "./v62-migration.js";
import { assertNoLiveRuntimeSchemaUpgrade } from "./upgrade-guard.js";

export const LOCAL_SCHEMA_VERSION = 63;

export function migrateLocalDatabase(database: DatabaseSync): void {
  const declaredVersion = schemaVersion(database);
  assertNoLiveRuntimeSchemaUpgrade(database, declaredVersion, LOCAL_SCHEMA_VERSION);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  if (declaredVersion !== undefined && declaredVersion > LOCAL_SCHEMA_VERSION) {
    throw new Error(
      `Local database schema ${declaredVersion} is newer than supported ${LOCAL_SCHEMA_VERSION}`
    );
  }
  if (isCurrentSchema(database)) {
    dropChatProjectionObjects(database);
    createSchema(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 62) {
    assertV62SchemaShape(database);
    migrateV62Schema(database, LOCAL_SCHEMA_VERSION);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 61) {
    assertV61SchemaShape(database);
    migrateV61Schema(database, 62);
    assertV62SchemaShape(database);
    migrateV62Schema(database, LOCAL_SCHEMA_VERSION);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === LOCAL_SCHEMA_VERSION) {
    throw new Error(`Local database schema ${LOCAL_SCHEMA_VERSION} is incomplete`);
  }
  if (declaredVersion === 60) {
    upgradeFromV60(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 59) {
    assertV59SchemaShape(database);
    migrateV59Schema(database, 60);
    upgradeFromV60(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 58) {
    assertV58SchemaShape(database);
    migrateV58Schema(database, 60);
    upgradeFromV60(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 57) {
    assertV57SchemaShape(database);
    migrateV57Schema(database, 60);
    upgradeFromV60(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 56) {
    assertV56SchemaShape(database);
    migrateV56Schema(database, 60);
    upgradeFromV60(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 55) {
    assertV55SchemaShape(database);
    migrateV55Schema(database, 60);
    upgradeFromV60(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 54) {
    assertV54SchemaShape(database);
    migrateV54Schema(database, 60);
    upgradeFromV60(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion === 53) {
    assertV53SchemaShape(database);
    migrateV53Schema(database, 60);
    upgradeFromV60(database);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  if (declaredVersion !== undefined && !hasAnyProductTable(database)) {
    throw new Error(`Local database schema ${declaredVersion} is incomplete`);
  }
  if (hasAnyProductTable(database) &&
    (declaredVersion === undefined || declaredVersion < 44 || declaredVersion > 58)) {
    throw new Error(
      `Local database schema ${declaredVersion} cannot migrate directly to ${LOCAL_SCHEMA_VERSION}`
    );
  }
  if (hasAnyProductTable(database)) {
    assertSupportedSchemaShape(database, declaredVersion!);
    migrateV44Schema(database, LOCAL_SCHEMA_VERSION);
    backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
    return;
  }
  createSchema(database);
  writeSchemaVersion(database, LOCAL_SCHEMA_VERSION);
  backfillScheduleCallbacks(database);
    migrateCurrentRuntimeData(database);
}

function migrateCurrentRuntimeData(database: DatabaseSync): void {
  database.exec(`
    UPDATE agents
    SET current_session_id = NULL
    WHERE current_session_id IN (
      SELECT session_id
      FROM agent_sessions
      WHERE adapter_id = 'kimi-code-runtime-jsonl-v1'
    )
  `);
  migrateLegacyAgentTurnOutputs(database);
}

function migrateLegacyAgentTurnOutputs(database: DatabaseSync): void {
  database.exec(`
    UPDATE events
    SET output = json_set(
      json_remove(output, '$.workflowResult'),
      '$.outputs',
      json_array(json_object(
        'id', 'result',
        'title', 'Workflow result',
        'contentType', 'application/json',
        'schemaVersion', json_extract(output, '$.workflowResult.schemaVersion'),
        'value', json(json_extract(output, '$.workflowResult'))
      ))
    )
    WHERE type = 'agent.result'
      AND outcome = 'succeeded'
      AND json_valid(output)
      AND json_type(output, '$.workflowResult') = 'object'
      AND json_type(output, '$.workflowResult.schemaVersion') = 'text'
      AND json_type(output, '$.outputs') IS NULL
  `);
}

function backfillScheduleCallbacks(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO proactive_callback_definitions (
      definition_id, callback_id, owner_kind, owner_id, owner_revision, ordinal,
      kind, definition_schema, definition_json, grant_json, created_at
    )
    SELECT
      'pcd_schedule_' || schedule_id || '_' || current_revision,
      'agent', 'schedule', schedule_id, current_revision, 0,
      'agent.invoke', 'ProactiveCallbackDefinition@1',
      CASE WHEN fixed_session_id IS NULL THEN json_object(
        'schemaVersion', 'ProactiveCallbackDefinition@1',
        'callbackId', 'agent', 'kind', 'agent.invoke', 'agentId', agent_id,
        'workspace', workspace, 'prompt', prompt
      ) ELSE json_object(
        'schemaVersion', 'ProactiveCallbackDefinition@1',
        'callbackId', 'agent', 'kind', 'agent.invoke', 'agentId', agent_id,
        'workspace', workspace, 'prompt', prompt, 'sessionId', fixed_session_id
      ) END,
      json_object(
        'schemaVersion', 'ProactiveCallbackGrant@1',
        'kind', 'agent.invoke', 'agentId', agent_id, 'workspace', workspace,
        'workspaceAccess', 'write', 'networkAccess', json('true')
      ),
      revision_created_at
    FROM schedules AS schedule
    WHERE NOT EXISTS (
      SELECT 1 FROM proactive_callback_definitions AS callback
      WHERE callback.owner_kind = 'schedule'
        AND callback.owner_id = schedule.schedule_id
        AND callback.owner_revision = schedule.current_revision
    );
  `);
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
  const currentTables = tables.filter((table) =>
    !LEGACY_RELEASE_CANDIDATE_TABLES.some((legacy) => legacy === table));
  return currentTables.length === TARGET_TABLES.length &&
    TARGET_TABLES.every((table) => currentTables.includes(table)) &&
    hasSupportedLegacyReleaseCandidateTables(database, tables) &&
    ["schedules", "subscriptions", "continuous_subscriptions"].every((table) =>
      tableColumns(database, table).includes("external_ref_binding_json")
    ) &&
    ["orchestration_mode", "orchestrator_binding_json", "checkpoint_json"].every(
      (column) => tableColumns(database, "agent_runs").includes(column)
    ) && ["series_key", "active_cycle_id"].every(
      (column) => tableColumns(database, "agent_runs").includes(column)
    ) && tableColumns(database, "agent_sessions").includes("cycle_id") &&
    hasVikunjaTaskDeliveryKind(database) && hasInitialStewardRunShape(database);
}

function upgradeFromV60(database: DatabaseSync): void {
  assertV60SchemaShape(database);
  migrateV60Schema(database, 61);
  assertV61SchemaShape(database);
  migrateV61Schema(database, 62);
  assertV62SchemaShape(database);
  migrateV62Schema(database, LOCAL_SCHEMA_VERSION);
}
