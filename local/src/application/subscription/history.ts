import type { DatabaseSync } from "node:sqlite";

import { requireLocalId } from "../../core/id.js";
import type {
  RuntimeDelivery,
  RuntimeDestination,
  RuntimeExecution,
  RuntimeHandlerKind
} from "../../core/runtime/model.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from
  "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from
  "../../infrastructure/sqlite/schema/index.js";

export type SubscriptionHistoryReasonCode =
  | "legacy_link_not_recorded"
  | "delivery_result_chain_incomplete";

export type SubscriptionHistoryQueryReasonCode =
  | SubscriptionHistoryReasonCode
  | "invalid_subscription_id"
  | "subscription_not_found"
  | "ambiguous_subscription_id"
  | "query_failed";

export interface SubscriptionHistoryExecution {
  readonly executionId: string;
  readonly eventId: string;
  readonly handler: RuntimeHandlerKind;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly status: RuntimeExecution["status"];
  readonly lastError: string | null;
  readonly nextAttemptAt: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface SubscriptionHistoryDelivery {
  readonly deliveryId: string;
  readonly resultEventId: string;
  readonly origin: {
    readonly kind: "event";
    readonly id: string;
  };
  readonly destination: {
    readonly id: string;
    readonly kind: RuntimeDestination["kind"];
  };
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly status: RuntimeDelivery["status"];
  readonly lastError: string | null;
  readonly nextAttemptAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly executions: readonly SubscriptionHistoryExecution[];
}

export interface SubscriptionHistoryResultEvent {
  readonly eventId: string;
  readonly outcome: "succeeded" | "failed";
  readonly output: string | null;
  readonly error: string | null;
  readonly createdAt: string;
}

export interface SubscriptionHistoryFire {
  readonly eventId: string;
  readonly type: "subscription.fire" | "agent.request";
  readonly source: {
    readonly kind: "subscription";
    readonly externalId: string | null;
  };
  readonly rootEventId: string;
  readonly parentEventId: string | null;
  readonly agentId: string;
  readonly sessionId: string | null;
  readonly status: RuntimeExecution["status"];
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly resultEvent: SubscriptionHistoryResultEvent;
  readonly deliveries: readonly SubscriptionHistoryDelivery[];
}

export interface SubscriptionHistory {
  readonly schemaVersion: "SubscriptionHistory@1";
  readonly queryStatus: "ok";
  readonly subscriptionId: string;
  readonly linkStatus: "resolved" | "unresolved";
  readonly reasonCode: SubscriptionHistoryReasonCode | null;
  readonly fires: readonly SubscriptionHistoryFire[];
}

export interface SubscriptionHistoryQuery {
  readonly queryStatus: "success" | "error";
  readonly subscriptionId: string;
  readonly linkStatus: "resolved" | "unresolved";
  readonly reasonCode: SubscriptionHistoryQueryReasonCode | null;
  readonly fires: readonly SubscriptionHistoryFire[];
}

interface SubscriptionPresenceRow {
  readonly kind: "free" | "continuous";
  readonly historical_evidence: number;
}

interface SubscriptionReferenceRow {
  readonly subscription_id: string;
}

const COMPACT_SUBSCRIPTION_ID = /^sub_[0-9a-f]{8,32}$/u;

const RESOLVE_SUBSCRIPTION_REFERENCE = `
  SELECT subscription_id FROM (
    SELECT subscription_id FROM subscriptions
    WHERE subscription_id LIKE $subscriptionReference || '%'
    UNION ALL
    SELECT subscription_id FROM continuous_subscriptions
    WHERE subscription_id LIKE $subscriptionReference || '%'
  )
  ORDER BY subscription_id
  LIMIT 2
`;

interface SubscriptionHistoryRow {
  readonly delivery_id: string;
  readonly delivery_result_event_id: string | null;
  readonly delivery_origin_kind: string;
  readonly delivery_origin_id: string;
  readonly destination_id: string;
  readonly destination_kind: RuntimeDestination["kind"];
  readonly delivery_status: RuntimeDelivery["status"];
  readonly delivery_attempt_count: number;
  readonly delivery_max_attempts: number;
  readonly delivery_next_attempt_at: string;
  readonly delivery_last_error: string | null;
  readonly delivery_created_at: string;
  readonly delivery_updated_at: string;
  readonly result_event_id: string | null;
  readonly result_event_type: string | null;
  readonly result_outcome: string | null;
  readonly result_output: string | null;
  readonly result_error: string | null;
  readonly result_root_event_id: string | null;
  readonly result_parent_event_id: string | null;
  readonly result_causal_hop: number | null;
  readonly result_created_at: string | null;
  readonly fire_event_id: string | null;
  readonly fire_event_type: string | null;
  readonly fire_source_kind: string | null;
  readonly fire_source_external_id: string | null;
  readonly fire_agent_id: string | null;
  readonly fire_session_id: string | null;
  readonly fire_root_event_id: string | null;
  readonly fire_parent_event_id: string | null;
  readonly fire_causal_hop: number | null;
  readonly fire_created_at: string | null;
  readonly execution_id: string | null;
  readonly execution_event_id: string | null;
  readonly execution_handler: string | null;
  readonly execution_status: RuntimeExecution["status"] | null;
  readonly execution_attempt_count: number | null;
  readonly execution_max_attempts: number | null;
  readonly execution_next_attempt_at: string | null;
  readonly execution_last_error: string | null;
  readonly execution_created_at: string | null;
  readonly execution_started_at: string | null;
  readonly execution_completed_at: string | null;
  readonly execution_updated_at: string | null;
}

const SUBSCRIPTION_PRESENCE = `
  SELECT 'free' AS kind,
    CASE WHEN terminal_key IS NOT NULL OR callback_phase_status <> 'pending'
      OR EXISTS (
        SELECT 1 FROM proactive_callback_occurrences AS occurrence
        WHERE occurrence.owner_kind = 'subscription'
          AND occurrence.owner_id = subscriptions.subscription_id
      )
      THEN 1 ELSE 0 END AS historical_evidence
  FROM subscriptions
  WHERE subscription_id = $subscriptionId
  UNION ALL
  SELECT 'continuous' AS kind,
    CASE WHEN checkpoint_occurrence_key IS NOT NULL OR pending_occurrence_key IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM proactive_callback_occurrences AS occurrence
        WHERE occurrence.owner_kind = 'continuous_subscription'
          AND occurrence.owner_id = continuous_subscriptions.subscription_id
      )
      THEN 1 ELSE 0 END AS historical_evidence
  FROM continuous_subscriptions
  WHERE subscription_id = $subscriptionId
`;

const SUBSCRIPTION_HISTORY_ROWS = `
  SELECT
    delivery.delivery_id,
    delivery.result_event_id AS delivery_result_event_id,
    delivery.origin_kind AS delivery_origin_kind,
    delivery.origin_id AS delivery_origin_id,
    delivery.destination_id,
    delivery.destination_kind,
    delivery.status AS delivery_status,
    delivery.attempt_count AS delivery_attempt_count,
    delivery.max_attempts AS delivery_max_attempts,
    delivery.next_attempt_at AS delivery_next_attempt_at,
    delivery.last_error AS delivery_last_error,
    delivery.created_at AS delivery_created_at,
    delivery.updated_at AS delivery_updated_at,
    result.event_id AS result_event_id,
    result.type AS result_event_type,
    result.outcome AS result_outcome,
    result.output AS result_output,
    result.error AS result_error,
    result.root_event_id AS result_root_event_id,
    result.parent_event_id AS result_parent_event_id,
    result.causal_hop AS result_causal_hop,
    result.created_at AS result_created_at,
    fire.event_id AS fire_event_id,
    fire.type AS fire_event_type,
    fire.source_kind AS fire_source_kind,
    fire.source_external_id AS fire_source_external_id,
    fire.agent_id AS fire_agent_id,
    fire.session_id AS fire_session_id,
    fire.root_event_id AS fire_root_event_id,
    fire.parent_event_id AS fire_parent_event_id,
    fire.causal_hop AS fire_causal_hop,
    fire.created_at AS fire_created_at,
    execution.execution_id,
    execution.event_id AS execution_event_id,
    execution.handler AS execution_handler,
    execution.status AS execution_status,
    execution.attempt_count AS execution_attempt_count,
    execution.max_attempts AS execution_max_attempts,
    execution.next_attempt_at AS execution_next_attempt_at,
    execution.last_error AS execution_last_error,
    execution.created_at AS execution_created_at,
    execution.started_at AS execution_started_at,
    execution.completed_at AS execution_completed_at,
    execution.updated_at AS execution_updated_at
  FROM deliveries AS delivery
  LEFT JOIN events AS result ON result.event_id = delivery.result_event_id
  LEFT JOIN events AS fire ON fire.event_id = result.parent_event_id
  LEFT JOIN executions AS execution
    ON execution.event_id = fire.event_id AND execution.handler = 'agent'
  WHERE json_type(delivery.destination_address_json, '$.subscriptionId') = 'text'
    AND json_extract(delivery.destination_address_json, '$.subscriptionId') = $subscriptionId
  ORDER BY fire.created_at, fire.event_id, delivery.created_at, delivery.delivery_id
`;

export function subscriptionHistory(
  repoRoot: string,
  subscriptionId: string,
  runtimeDirectory?: string
): SubscriptionHistory {
  const id = requireLocalId(subscriptionId, "sub", "subscriptionId");
  const database = openRuntimeDatabaseReadOnly(
    runtimePaths(repoRoot, runtimeDirectory).database
  );
  try {
    assertCurrentLocalSchema(database);
    database.exec("BEGIN");
    const result = historyInTransaction(database, id);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export function subscriptionHistoryByReference(
  repoRoot: string,
  subscriptionReference: string,
  runtimeDirectory?: string
): SubscriptionHistoryQuery {
  const normalizedReference = normalizeSubscriptionReference(subscriptionReference);
  if (normalizedReference === undefined) {
    return queryError(subscriptionReference, "invalid_subscription_id");
  }
  let database: DatabaseSync | undefined;
  try {
    database = openRuntimeDatabaseReadOnly(
      runtimePaths(repoRoot, runtimeDirectory).database
    );
    assertCurrentLocalSchema(database);
    database.exec("BEGIN");
    const matches = database.prepare(RESOLVE_SUBSCRIPTION_REFERENCE).all({
      subscriptionReference: normalizedReference
    }) as unknown as SubscriptionReferenceRow[];
    if (matches.length === 0) {
      database.exec("COMMIT");
      return queryError(subscriptionReference, "subscription_not_found");
    }
    if (matches.length > 1) {
      database.exec("COMMIT");
      return queryError(subscriptionReference, "ambiguous_subscription_id");
    }
    const history = historyInTransaction(database, matches[0]!.subscription_id);
    database.exec("COMMIT");
    return {
      queryStatus: history.linkStatus === "resolved" ? "success" : "error",
      subscriptionId: history.subscriptionId,
      linkStatus: history.linkStatus,
      reasonCode: history.reasonCode,
      fires: history.fires
    };
  } catch {
    if (database?.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The stable query error below is the only public failure detail.
      }
    }
    return queryError(subscriptionReference, "query_failed");
  } finally {
    try {
      database?.close();
    } catch {
      // Read-only query cleanup must not replace the stable result contract.
    }
  }
}

function historyInTransaction(
  database: DatabaseSync,
  subscriptionId: string
): SubscriptionHistory {
  const presence = database.prepare(SUBSCRIPTION_PRESENCE).all({
    subscriptionId
  }) as unknown as SubscriptionPresenceRow[];
  if (presence.length === 0) {
    throw new Error(`Subscription not found: ${subscriptionId}`);
  }
  const rows = database.prepare(SUBSCRIPTION_HISTORY_ROWS).all({
    subscriptionId
  }) as unknown as SubscriptionHistoryRow[];
  if (rows.length === 0) {
    const unresolved = presence.some((row) => row.historical_evidence === 1);
    return historyResult(
      subscriptionId,
      unresolved ? "unresolved" : "resolved",
      unresolved ? "legacy_link_not_recorded" : null,
      []
    );
  }

  let incomplete = false;
  const fires = new Map<string, BuildingSubscriptionHistoryFire>();
  for (const row of rows) {
    if (!isCompleteHistoryRow(row)) {
      incomplete = true;
      continue;
    }
    const execution: SubscriptionHistoryExecution = {
      executionId: row.execution_id,
      eventId: row.execution_event_id,
      handler: row.execution_handler,
      attempt: row.execution_attempt_count,
      maxAttempts: row.execution_max_attempts,
      status: row.execution_status,
      lastError: row.execution_last_error,
      nextAttemptAt: row.execution_next_attempt_at,
      createdAt: row.execution_created_at,
      startedAt: row.execution_started_at,
      completedAt: row.execution_completed_at,
      updatedAt: row.execution_updated_at
    };
    const delivery: SubscriptionHistoryDelivery = {
      deliveryId: row.delivery_id,
      resultEventId: row.result_event_id,
      origin: { kind: "event", id: row.delivery_origin_id },
      destination: { id: row.destination_id, kind: row.destination_kind },
      attempt: row.delivery_attempt_count,
      maxAttempts: row.delivery_max_attempts,
      status: row.delivery_status,
      lastError: row.delivery_last_error,
      nextAttemptAt: row.delivery_next_attempt_at,
      createdAt: row.delivery_created_at,
      updatedAt: row.delivery_updated_at,
      executions: [execution]
    };
    const existing = fires.get(row.fire_event_id);
    if (existing !== undefined) {
      if (existing.resultEvent.eventId !== row.result_event_id) incomplete = true;
      existing.deliveries.push(delivery);
      continue;
    }
    fires.set(row.fire_event_id, {
      eventId: row.fire_event_id,
      type: row.fire_event_type,
      source: {
        kind: "subscription",
        externalId: row.fire_source_external_id
      },
      rootEventId: row.fire_root_event_id,
      parentEventId: row.fire_parent_event_id,
      agentId: row.fire_agent_id,
      sessionId: row.fire_session_id,
      status: row.execution_status,
      lastError: row.execution_last_error,
      createdAt: row.fire_created_at,
      resultEvent: {
        eventId: row.result_event_id,
        outcome: row.result_outcome,
        output: boundedResultText(row.result_output),
        error: boundedResultText(row.result_error),
        createdAt: row.result_created_at
      },
      deliveries: [delivery]
    });
  }
  return historyResult(
    subscriptionId,
    incomplete ? "unresolved" : "resolved",
    incomplete ? "delivery_result_chain_incomplete" : null,
    [...fires.values()]
  );
}

function historyResult(
  subscriptionId: string,
  linkStatus: SubscriptionHistory["linkStatus"],
  reasonCode: SubscriptionHistory["reasonCode"],
  fires: readonly SubscriptionHistoryFire[]
): SubscriptionHistory {
  return {
    schemaVersion: "SubscriptionHistory@1",
    queryStatus: "ok",
    subscriptionId,
    linkStatus,
    reasonCode,
    fires
  };
}

function queryError(
  subscriptionId: string,
  reasonCode: Exclude<SubscriptionHistoryQueryReasonCode, SubscriptionHistoryReasonCode>
): SubscriptionHistoryQuery {
  return {
    queryStatus: "error",
    subscriptionId,
    linkStatus: "unresolved",
    reasonCode,
    fires: []
  };
}

function normalizeSubscriptionReference(value: string): string | undefined {
  try {
    requireLocalId(value, "sub", "subscriptionId");
    return value;
  } catch {
    if (!COMPACT_SUBSCRIPTION_ID.test(value)) return undefined;
    const hex = value.slice(4);
    if ((hex.length >= 13 && hex[12] !== "7") ||
      (hex.length >= 17 && !/[89ab]/u.test(hex[16]!))) {
      return undefined;
    }
    const groups = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].filter((group) => group.length > 0);
    return `sub_${groups.join("-")}`;
  }
}

function isCompleteHistoryRow(row: SubscriptionHistoryRow): row is CompleteHistoryRow {
  return row.delivery_origin_kind === "event" &&
    row.delivery_result_event_id !== null &&
    row.delivery_origin_id === row.delivery_result_event_id &&
    row.result_event_id === row.delivery_result_event_id &&
    row.result_event_type === "agent.result" &&
    (row.result_outcome === "succeeded" || row.result_outcome === "failed") &&
    row.result_root_event_id !== null &&
    row.result_parent_event_id !== null &&
    row.result_causal_hop !== null &&
    row.result_created_at !== null &&
    row.fire_event_id === row.result_parent_event_id &&
    (row.fire_event_type === "subscription.fire" || row.fire_event_type === "agent.request") &&
    row.fire_source_kind === "subscription" &&
    row.fire_agent_id !== null &&
    row.fire_root_event_id === row.result_root_event_id &&
    row.fire_causal_hop !== null &&
    row.result_causal_hop === row.fire_causal_hop + 1 &&
    row.fire_created_at !== null &&
    row.execution_id !== null &&
    row.execution_event_id === row.fire_event_id &&
    row.execution_handler === "agent" &&
    row.execution_status !== null &&
    row.execution_attempt_count !== null &&
    row.execution_max_attempts !== null &&
    row.execution_next_attempt_at !== null &&
    row.execution_created_at !== null &&
    row.execution_updated_at !== null;
}

type CompleteHistoryRow = SubscriptionHistoryRow & {
  readonly delivery_result_event_id: string;
  readonly delivery_origin_kind: "event";
  readonly result_event_id: string;
  readonly result_event_type: "agent.result";
  readonly result_outcome: "succeeded" | "failed";
  readonly result_root_event_id: string;
  readonly result_parent_event_id: string;
  readonly result_causal_hop: number;
  readonly result_created_at: string;
  readonly fire_event_id: string;
  readonly fire_event_type: "subscription.fire" | "agent.request";
  readonly fire_source_kind: "subscription";
  readonly fire_agent_id: string;
  readonly fire_root_event_id: string;
  readonly fire_parent_event_id: string | null;
  readonly fire_causal_hop: number;
  readonly fire_created_at: string;
  readonly execution_id: string;
  readonly execution_event_id: string;
  readonly execution_handler: "agent";
  readonly execution_status: RuntimeExecution["status"];
  readonly execution_attempt_count: number;
  readonly execution_max_attempts: number;
  readonly execution_next_attempt_at: string;
  readonly execution_created_at: string;
  readonly execution_updated_at: string;
};

type BuildingSubscriptionHistoryFire =
  Omit<SubscriptionHistoryFire, "deliveries"> & {
    readonly deliveries: SubscriptionHistoryDelivery[];
  };

function boundedResultText(value: string | null): string | null {
  if (value === null || value.length <= 4_096) return value;
  return `${value.slice(0, 4_095)}…`;
}
