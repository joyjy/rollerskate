import type { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabaseReadOnly } from "./database.js";

export type LegacyOwnerKind = "schedule" | "subscription" | "continuous_subscription";
export type LegacyCallbackKind = "agent.invoke" | "command.exec" | "destination.deliver";

export interface LegacyCallbackInventoryItem {
  readonly callbackId: string;
  readonly kind: LegacyCallbackKind;
  readonly definitionSchema: "ProactiveCallbackDefinition@1";
  readonly migration:
    | "recompile_agent_run"
    | "owner_decision_workflow"
    | "owner_decision_delivery_role";
  readonly agentId?: string;
  readonly workspace?: string;
  readonly executable?: string;
  readonly destinationId?: string;
  readonly lastOccurrence?: {
    readonly occurrenceId: string;
    readonly occurrenceKey: string;
    readonly status: string;
    readonly updatedAt: string;
  };
}

export interface LegacyDefinitionInventoryItem {
  readonly ownerKind: LegacyOwnerKind;
  readonly ownerId: string;
  readonly ownerStatus: "active" | "paused";
  readonly definitionSchema: string;
  readonly definitionRevision: string;
  readonly callbacks: readonly LegacyCallbackInventoryItem[];
  readonly recovery: Readonly<Record<string, unknown>>;
}

export interface LegacyExecutionInventory {
  readonly schemaVersion: "LegacyExecutionInventory@1";
  readonly generatedAt: string;
  readonly summary: {
    readonly definitionOwners: number;
    readonly callbackDefinitions: number;
    readonly automaticAgentMappings: number;
    readonly ownerDecisions: number;
    readonly unterminatedOccurrences: number;
  };
  readonly definitions: readonly LegacyDefinitionInventoryItem[];
  readonly unterminatedOccurrences: readonly {
    readonly occurrenceId: string;
    readonly ownerKind: LegacyOwnerKind;
    readonly ownerId: string;
    readonly ownerRevision: number;
    readonly occurrenceKey: string;
    readonly callbackId: string;
    readonly kind: LegacyCallbackKind;
    readonly status: "pending" | "started" | "unknown";
    readonly updatedAt: string;
  }[];
}

interface OwnerRow {
  readonly owner_kind: LegacyOwnerKind;
  readonly owner_id: string;
  readonly owner_status: "active" | "paused";
  readonly callback_revision: number;
  readonly definition_schema: string;
  readonly definition_revision: string;
  readonly recovery_json: string;
}

interface CallbackRow {
  readonly owner_kind: LegacyOwnerKind;
  readonly owner_id: string;
  readonly owner_revision: number;
  readonly callback_id: string;
  readonly kind: LegacyCallbackKind;
  readonly definition_schema: "ProactiveCallbackDefinition@1";
  readonly definition_json: string;
  readonly occurrence_id: string | null;
  readonly trigger_occurrence_key: string | null;
  readonly occurrence_status: string | null;
  readonly occurrence_updated_at: string | null;
}

interface UnterminatedRow {
  readonly occurrence_id: string;
  readonly owner_kind: LegacyOwnerKind;
  readonly owner_id: string;
  readonly owner_revision: number;
  readonly trigger_occurrence_key: string;
  readonly callback_id: string;
  readonly kind: LegacyCallbackKind;
  readonly status: "pending" | "started" | "unknown";
  readonly updated_at: string;
}

export function readLegacyExecutionInventory(
  databasePath: string,
  at = new Date().toISOString()
): LegacyExecutionInventory {
  const database = openRuntimeDatabaseReadOnly(databasePath);
  try {
    return inventory(database, iso(at));
  } finally {
    database.close();
  }
}

function inventory(database: DatabaseSync, generatedAt: string): LegacyExecutionInventory {
  const owners = database.prepare(`
    SELECT 'schedule' AS owner_kind, schedule_id AS owner_id,
      status AS owner_status, current_revision AS callback_revision,
      'ScheduleRevision@1' AS definition_schema,
      CAST(current_revision AS TEXT) AS definition_revision,
      json_object(
        'nextRunAt', next_run_at,
        'nextOccurrenceKey', next_occurrence_key,
        'nextOccurrenceMissing', json(iif(next_occurrence_missing = 1, 'true', 'false'))
      ) AS recovery_json
    FROM schedules WHERE status IN ('active', 'paused')
    UNION ALL
    SELECT 'subscription', subscription_id, status, 1, definition_schema,
      definition_revision,
      json_object(
        'callbackPhaseStatus', callback_phase_status,
        'terminalKey', terminal_key,
        'latestError', latest_error
      )
    FROM subscriptions WHERE status IN ('active', 'paused')
    UNION ALL
    SELECT 'continuous_subscription', subscription_id, status, current_revision,
      'ContinuousSubscriptionDefinition@1', CAST(current_revision AS TEXT),
      json_object(
        'pendingOccurrenceKey', pending_occurrence_key,
        'checkpointOccurrenceKey', checkpoint_occurrence_key,
        'latestError', latest_error
      )
    FROM continuous_subscriptions WHERE status IN ('active', 'paused')
    ORDER BY owner_kind, owner_id
  `).all() as unknown as OwnerRow[];
  const callbacks = database.prepare(`
    WITH active_owners(owner_kind, owner_id, owner_revision) AS (
      SELECT 'schedule', schedule_id, current_revision
      FROM schedules WHERE status IN ('active', 'paused')
      UNION ALL
      SELECT 'subscription', subscription_id, 1
      FROM subscriptions WHERE status IN ('active', 'paused')
      UNION ALL
      SELECT 'continuous_subscription', subscription_id, current_revision
      FROM continuous_subscriptions WHERE status IN ('active', 'paused')
    ), ranked_occurrences AS (
      SELECT occurrence.*,
        row_number() OVER (
          PARTITION BY occurrence.owner_kind, occurrence.owner_id,
            occurrence.owner_revision, occurrence.callback_id
          ORDER BY occurrence.created_at DESC, occurrence.occurrence_id DESC
        ) AS rank
      FROM proactive_callback_occurrences AS occurrence
      JOIN active_owners AS owner
        ON owner.owner_kind = occurrence.owner_kind
        AND owner.owner_id = occurrence.owner_id
        AND owner.owner_revision = occurrence.owner_revision
    )
    SELECT definition.owner_kind, definition.owner_id, definition.owner_revision,
      definition.callback_id, definition.kind, definition.definition_schema,
      definition.definition_json, occurrence.occurrence_id,
      occurrence.trigger_occurrence_key, occurrence.status AS occurrence_status,
      occurrence.updated_at AS occurrence_updated_at
    FROM active_owners AS owner
    JOIN proactive_callback_definitions AS definition
      ON definition.owner_kind = owner.owner_kind
      AND definition.owner_id = owner.owner_id
      AND definition.owner_revision = owner.owner_revision
    LEFT JOIN ranked_occurrences AS occurrence
      ON occurrence.owner_kind = definition.owner_kind
      AND occurrence.owner_id = definition.owner_id
      AND occurrence.owner_revision = definition.owner_revision
      AND occurrence.callback_id = definition.callback_id
      AND occurrence.rank = 1
    ORDER BY definition.owner_kind, definition.owner_id, definition.ordinal
  `).all() as unknown as CallbackRow[];
  const unterminatedRows = database.prepare(`
    SELECT occurrence_id, owner_kind, owner_id, owner_revision,
      trigger_occurrence_key, callback_id, kind, status, updated_at
    FROM proactive_callback_occurrences
    WHERE status IN ('pending', 'started', 'unknown')
    ORDER BY created_at, owner_kind, owner_id, ordinal
  `).all() as unknown as UnterminatedRow[];
  const callbacksByOwner = new Map<string, LegacyCallbackInventoryItem[]>();
  for (const row of callbacks) {
    const definition = jsonRecord(row.definition_json, "legacy callback definition");
    const item: LegacyCallbackInventoryItem = {
      callbackId: row.callback_id,
      kind: row.kind,
      definitionSchema: row.definition_schema,
      migration: row.kind === "agent.invoke"
        ? "recompile_agent_run"
        : row.kind === "command.exec"
          ? "owner_decision_workflow"
          : "owner_decision_delivery_role",
      ...optionalString(definition, "agentId"),
      ...workspaceField(definition),
      ...optionalString(definition, "executable"),
      ...optionalString(definition, "destinationId"),
      ...(row.occurrence_id === null
        ? {}
        : {
            lastOccurrence: {
              occurrenceId: row.occurrence_id,
              occurrenceKey: row.trigger_occurrence_key!,
              status: row.occurrence_status!,
              updatedAt: row.occurrence_updated_at!
            }
          })
    };
    const key = ownerKey(row.owner_kind, row.owner_id, row.owner_revision);
    const items = callbacksByOwner.get(key) ?? [];
    items.push(item);
    callbacksByOwner.set(key, items);
  }
  const definitions = owners.map((owner): LegacyDefinitionInventoryItem => ({
    ownerKind: owner.owner_kind,
    ownerId: owner.owner_id,
    ownerStatus: owner.owner_status,
    definitionSchema: owner.definition_schema,
    definitionRevision: owner.definition_revision,
    callbacks: callbacksByOwner.get(ownerKey(
      owner.owner_kind,
      owner.owner_id,
      owner.callback_revision
    )) ?? [],
    recovery: jsonRecord(owner.recovery_json, "legacy owner recovery")
  }));
  const callbackDefinitions = callbacks.length;
  const automaticAgentMappings = callbacks.filter(
    ({ kind }) => kind === "agent.invoke"
  ).length;
  return {
    schemaVersion: "LegacyExecutionInventory@1",
    generatedAt,
    summary: {
      definitionOwners: definitions.length,
      callbackDefinitions,
      automaticAgentMappings,
      ownerDecisions: callbackDefinitions - automaticAgentMappings,
      unterminatedOccurrences: unterminatedRows.length
    },
    definitions,
    unterminatedOccurrences: unterminatedRows.map((row) => ({
      occurrenceId: row.occurrence_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      ownerRevision: row.owner_revision,
      occurrenceKey: row.trigger_occurrence_key,
      callbackId: row.callback_id,
      kind: row.kind,
      status: row.status,
      updatedAt: row.updated_at
    }))
  };
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  field: "agentId" | "executable" | "destinationId"
): Readonly<Record<string, string>> {
  const item = value[field];
  return typeof item === "string" && item !== "" ? { [field]: item } : {};
}

function workspaceField(value: Readonly<Record<string, unknown>>): {
  readonly workspace?: string;
} {
  const workspace = value.workspace ?? value.cwd;
  return typeof workspace === "string" && workspace !== "" ? { workspace } : {};
}

function jsonRecord(value: string, field: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${field} must be an object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function ownerKey(kind: LegacyOwnerKind, id: string, revision: number): string {
  return `${kind}\0${id}\0${revision}`;
}

function iso(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("inventory timestamp must be RFC3339");
  return new Date(value).toISOString();
}
