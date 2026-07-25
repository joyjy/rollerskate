import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface RuntimeWorkloadFacts {
  readonly readyExecutions: number;
  readonly runningExecutions: number;
  readonly retryingExecutions: number;
  readonly pendingDeliveries: number;
  readonly deliveringDeliveries: number;
  readonly retryingDeliveries: number;
  readonly pendingScheduledRuns: number;
  readonly runningScheduledRuns: number;
}

export interface RuntimeFailureFact {
  readonly kind: "execution" | "delivery" | "schedule" | "subscription" | "review";
  readonly objectRef: string;
  readonly eventId?: string;
  readonly relatedRef?: string;
  readonly reason: string;
  readonly occurredAt: string;
}

const EMPTY_WORKLOAD: RuntimeWorkloadFacts = {
  readyExecutions: 0,
  runningExecutions: 0,
  retryingExecutions: 0,
  pendingDeliveries: 0,
  deliveringDeliveries: 0,
  retryingDeliveries: 0,
  pendingScheduledRuns: 0,
  runningScheduledRuns: 0
};

export function readRuntimeWorkloadFacts(databasePath: string): RuntimeWorkloadFacts {
  if (!existsSync(databasePath)) return EMPTY_WORKLOAD;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      ...EMPTY_WORKLOAD,
      ...(hasTable(database, "executions")
        ? {
            readyExecutions: count(
              database,
              "SELECT COUNT(*) AS count FROM executions WHERE status = 'queued'"
            ),
            runningExecutions: count(
              database,
              "SELECT COUNT(*) AS count FROM executions WHERE status = 'running'"
            ),
            retryingExecutions: count(
              database,
              "SELECT COUNT(*) AS count FROM executions WHERE status = 'retry_wait'"
            )
          }
        : {}),
      ...(hasTable(database, "deliveries")
        ? {
            pendingDeliveries: count(
              database,
              "SELECT COUNT(*) AS count FROM deliveries WHERE status = 'pending'"
            ),
            deliveringDeliveries: count(
              database,
              "SELECT COUNT(*) AS count FROM deliveries WHERE status = 'delivering'"
            ),
            retryingDeliveries: count(
              database,
              "SELECT COUNT(*) AS count FROM deliveries WHERE status = 'retry_wait'"
            )
          }
        : {}),
      ...(hasTable(database, "scheduled_runs")
        ? {
            pendingScheduledRuns: count(database, `
              SELECT COUNT(*) AS count FROM scheduled_runs
              WHERE status = 'queued' AND event_id IS NULL
            `),
            runningScheduledRuns: count(database, `
              SELECT COUNT(*) AS count FROM scheduled_runs
              WHERE status = 'running' AND event_id IS NULL
            `)
          }
        : {})
    };
  } finally {
    database.close();
  }
}

export function readRuntimeFailureFacts(
  databasePath: string,
  limit = 200
): readonly RuntimeFailureFact[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("failure limit must be an integer between 1 and 1000");
  }
  if (!existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const facts: RuntimeFailureFact[] = [];
    if (hasTable(database, "executions")) {
      const rows = database.prepare(`
        SELECT execution_id, event_id, last_error, updated_at
        FROM executions
        WHERE status = 'failed' AND last_error IS NOT NULL
        ORDER BY updated_at DESC, execution_id DESC
        LIMIT ?
      `).all(limit) as unknown as Array<{
        execution_id: string;
        event_id: string;
        last_error: string;
        updated_at: string;
      }>;
      facts.push(...rows.map((row) => ({
        kind: "execution" as const,
        objectRef: row.execution_id,
        eventId: row.event_id,
        reason: row.last_error,
        occurredAt: row.updated_at
      })));
    }
    if (hasTable(database, "deliveries")) {
      const rows = database.prepare(`
        SELECT delivery_id, result_event_id, destination_id, last_error, updated_at
        FROM deliveries
        WHERE status = 'failed' AND last_error IS NOT NULL
        ORDER BY updated_at DESC, delivery_id DESC
        LIMIT ?
      `).all(limit) as unknown as Array<{
        delivery_id: string;
        result_event_id: string;
        destination_id: string;
        last_error: string;
        updated_at: string;
      }>;
      facts.push(...rows.map((row) => ({
        kind: "delivery" as const,
        objectRef: row.delivery_id,
        eventId: row.result_event_id,
        relatedRef: row.destination_id,
        reason: row.last_error,
        occurredAt: row.updated_at
      })));
    }
    if (hasTable(database, "scheduled_runs")) {
      const rows = database.prepare(`
        SELECT run_id, event_id, schedule_id, decision_reason, updated_at
        FROM scheduled_runs
        WHERE status = 'unknown'
        ORDER BY updated_at DESC, run_id DESC
        LIMIT ?
      `).all(limit) as unknown as Array<{
        run_id: string;
        event_id: string | null;
        schedule_id: string;
        decision_reason: string | null;
        updated_at: string;
      }>;
      facts.push(...rows.map((row) => ({
        kind: "schedule" as const,
        objectRef: row.run_id,
        ...(row.event_id === null ? {} : { eventId: row.event_id }),
        relatedRef: row.schedule_id,
        reason: row.decision_reason ?? "Scheduled run outcome is unknown.",
        occurredAt: row.updated_at
      })));
    }
    if (hasTable(database, "subscriptions")) {
      const rows = database.prepare(`
        SELECT subscription_id, fire_event_id, latest_error, updated_at
        FROM subscriptions
        WHERE latest_error IS NOT NULL
          AND status NOT IN ('cancelled', 'expired')
        ORDER BY updated_at DESC, subscription_id DESC
        LIMIT ?
      `).all(limit) as unknown as Array<{
        subscription_id: string;
        fire_event_id: string | null;
        latest_error: string;
        updated_at: string;
      }>;
      facts.push(...rows.map((row) => ({
        kind: "subscription" as const,
        objectRef: row.subscription_id,
        ...(row.fire_event_id === null ? {} : { eventId: row.fire_event_id }),
        reason: row.latest_error,
        occurredAt: row.updated_at
      })));
    }
    if (hasTable(database, "reviews")) {
      const rows = database.prepare(`
        SELECT root_event_id, terminal_reason, updated_at
        FROM reviews
        WHERE phase = 'terminal' AND terminal_decision = 'blocked'
        ORDER BY updated_at DESC, root_event_id DESC
        LIMIT ?
      `).all(limit) as unknown as Array<{
        root_event_id: string;
        terminal_reason: string | null;
        updated_at: string;
      }>;
      facts.push(...rows.map((row) => ({
        kind: "review" as const,
        objectRef: row.root_event_id,
        eventId: row.root_event_id,
        reason: row.terminal_reason ?? "Review chain is blocked.",
        occurredAt: row.updated_at
      })));
    }
    return facts
      .sort((left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) ||
        right.objectRef.localeCompare(left.objectRef))
      .slice(0, limit);
  } finally {
    database.close();
  }
}

export function countRecoverableRuntimeWork(databasePath: string): number {
  if (!existsSync(databasePath)) return 0;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const scheduledExecutionIds = hasTable(database, "scheduled_runs")
      ? "SELECT execution_id FROM scheduled_runs WHERE execution_id IS NOT NULL"
      : "SELECT NULL WHERE 0";
    const executions = hasTable(database, "executions")
      ? count(database, `
          SELECT COUNT(*) AS count FROM executions
          WHERE status = 'running'
            AND execution_id NOT IN (${scheduledExecutionIds})
        `)
      : 0;
    const scheduledRuns = hasTable(database, "scheduled_runs")
      ? count(database, "SELECT COUNT(*) AS count FROM scheduled_runs WHERE status = 'running'")
      : 0;
    const deliveries = hasTable(database, "deliveries")
      ? count(database, "SELECT COUNT(*) AS count FROM deliveries WHERE status = 'delivering'")
      : 0;
    return executions + scheduledRuns + deliveries;
  } finally {
    database.close();
  }
}

function count(database: DatabaseSync, sql: string): number {
  return Number((database.prepare(sql).get() as { count: number }).count);
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).get(table) !== undefined;
}
