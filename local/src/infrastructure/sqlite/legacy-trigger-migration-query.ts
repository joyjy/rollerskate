import type { DatabaseSync } from "node:sqlite";

import type { LegacyOwnerKind } from "./legacy-trigger-inventory-query.js";
import { openRuntimeDatabaseReadOnly } from "./database.js";
import { tableColumns } from "./schema/introspection.js";

export interface LegacyMigrationCallbackSnapshot {
  readonly callbackId: string;
  readonly ordinal: number;
  readonly kind: "agent.invoke" | "command.exec" | "destination.deliver";
  readonly definition: Readonly<Record<string, unknown>>;
  readonly grant: Readonly<Record<string, unknown>>;
}

export interface LegacyMigrationSourceSnapshot {
  readonly ownerKind: LegacyOwnerKind;
  readonly ownerId: string;
  readonly ownerStatus: "active" | "paused";
  readonly definitionSchema: string;
  readonly definitionRevision: string;
  readonly callbackOwnerRevision: number;
  readonly source: Readonly<Record<string, unknown>>;
  readonly callbacks: readonly LegacyMigrationCallbackSnapshot[];
  readonly unterminatedOccurrences: number;
}

interface OwnerRow {
  readonly owner_kind: LegacyOwnerKind;
  readonly owner_id: string;
  readonly owner_status: "active" | "paused";
  readonly definition_schema: string;
  readonly definition_revision: string;
  readonly callback_owner_revision: number;
  readonly source_json: string;
}

interface CallbackRow {
  readonly callback_id: string;
  readonly ordinal: number;
  readonly kind: LegacyMigrationCallbackSnapshot["kind"];
  readonly definition_json: string;
  readonly grant_json: string;
}

export function readLegacyMigrationSnapshots(
  databasePath: string
): readonly LegacyMigrationSourceSnapshot[] {
  const database = openRuntimeDatabaseReadOnly(databasePath);
  try {
    return legacyMigrationSnapshots(database);
  } finally {
    database.close();
  }
}

export function legacyMigrationSnapshots(
  database: DatabaseSync
): readonly LegacyMigrationSourceSnapshot[] {
  const scheduleHasSchema = tableColumns(database, "schedules").includes("definition_schema");
  const continuousHasSchema = tableColumns(
    database,
    "continuous_subscriptions"
  ).includes("definition_schema");
  const owners = database.prepare(`
    SELECT 'schedule' AS owner_kind, schedule_id AS owner_id, status AS owner_status,
      ${scheduleHasSchema ? "definition_schema" : "'ScheduleRevision@1'"}
        AS definition_schema,
      CAST(current_revision AS TEXT) AS definition_revision,
      current_revision AS callback_owner_revision,
      json_object(
        'kind', kind, 'expression', expression, 'timezone', timezone,
        'misfirePolicy', misfire_policy, 'overlapPolicy', overlap_policy,
        'misfireGraceMilliseconds', misfire_grace_ms
      ) AS source_json
    FROM schedules
    WHERE ${scheduleHasSchema ? "definition_schema = 'ScheduleRevision@1' AND" : ""}
      status IN ('active', 'paused')
    UNION ALL
    SELECT 'subscription', subscription_id, status, definition_schema,
      definition_revision, 1,
      json_object(
        'title', title, 'pluginPath', plugin_path, 'pluginId', plugin_id,
        'pluginConfig', json_extract(plugin_config_json, '$.config'),
        'policy', json(policy_json),
        'intervalMilliseconds', interval_ms, 'maxWaitMilliseconds', max_wait_ms,
        'maxAttempts', max_attempts
      )
    FROM subscriptions
    WHERE definition_schema = 'SubscriptionDefinition@3'
      AND status IN ('active', 'paused')
    UNION ALL
    SELECT 'continuous_subscription', subscription_id, status,
      ${continuousHasSchema
        ? "definition_schema"
        : "'ContinuousSubscriptionDefinition@1'"},
      CAST(current_revision AS TEXT), current_revision,
      json_object(
        'title', title, 'pluginPath', plugin_path, 'pluginId', plugin_id,
        'pluginConfig', json(plugin_config_json), 'policy', json(policy_json),
        'intervalMilliseconds', interval_ms
      )
    FROM continuous_subscriptions
    WHERE ${continuousHasSchema
      ? "definition_schema = 'ContinuousSubscriptionDefinition@1' AND"
      : ""} status IN ('active', 'paused')
    ORDER BY owner_kind, owner_id
  `).all() as unknown as OwnerRow[];
  return owners.map((owner) => {
    const callbacks = database.prepare(`
      SELECT callback_id, ordinal, kind, definition_json, grant_json
      FROM proactive_callback_definitions
      WHERE owner_kind = ? AND owner_id = ? AND owner_revision = ?
      ORDER BY ordinal, callback_id
    `).all(
      owner.owner_kind,
      owner.owner_id,
      owner.callback_owner_revision
    ) as unknown as CallbackRow[];
    const pending = database.prepare(`
      SELECT count(*) AS count
      FROM proactive_callback_occurrences
      WHERE owner_kind = ? AND owner_id = ? AND owner_revision = ?
        AND status IN ('pending', 'started', 'unknown')
    `).get(
      owner.owner_kind,
      owner.owner_id,
      owner.callback_owner_revision
    ) as { count: number };
    return {
      ownerKind: owner.owner_kind,
      ownerId: owner.owner_id,
      ownerStatus: owner.owner_status,
      definitionSchema: owner.definition_schema,
      definitionRevision: owner.definition_revision,
      callbackOwnerRevision: owner.callback_owner_revision,
      source: jsonRecord(owner.source_json, "legacy source snapshot"),
      callbacks: callbacks.map((callback) => ({
        callbackId: callback.callback_id,
        ordinal: callback.ordinal,
        kind: callback.kind,
        definition: jsonRecord(callback.definition_json, "legacy callback definition"),
        grant: jsonRecord(callback.grant_json, "legacy callback grant")
      })),
      unterminatedOccurrences: pending.count
    };
  });
}

function jsonRecord(value: string, field: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${field} must be an object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}
