import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { requireLocalId } from "../../core/id.js";

export type RunMonitorStatus = "active" | "blocked" | "completed";

export interface RunSubscription {
  readonly subscriptionId: string;
  readonly runId: string;
  readonly status: RunMonitorStatus;
  readonly observedKey: string | null;
  readonly runtimeIdentity: string | null;
  readonly latestError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Row {
  subscription_id: string;
  run_id: string;
  status: RunMonitorStatus;
  observed_key: string | null;
  runtime_identity: string | null;
  latest_error: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT subscription_id, run_id, status, observed_key,
  runtime_identity, latest_error, created_at, updated_at FROM run_subscriptions`;
const SUBSCRIPTION_ID = /^sub_run_[0-9a-f]{32}$/;

/** Uses the caller's DatabaseSync so Run admission and registration can share one transaction. */
export class RunMonitorStore {
  public constructor(private readonly database: DatabaseSync) {}

  public createInTransaction(runId: string, at: string): RunSubscription {
    this.requireTransaction();
    requireLocalId(runId, "run", "runId");
    const subscriptionId = runSubscriptionId(runId);
    this.database.prepare(`
      INSERT INTO run_subscriptions (subscription_id, run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `).run(subscriptionId, runId, timestamp(at), timestamp(at));
    return this.getByRun(runId)!;
  }

  public getByRun(runId: string): RunSubscription | undefined {
    requireLocalId(runId, "run", "runId");
    const row = this.database.prepare(`${SELECT} WHERE run_id = ?`).get(runId) as Row | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  public get(subscriptionId: string): RunSubscription | undefined {
    requireRunSubscriptionId(subscriptionId);
    const row = this.database.prepare(`${SELECT} WHERE subscription_id = ?`)
      .get(subscriptionId) as Row | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  public list(limit = 100): RunSubscription[] {
    requireLimit(limit);
    return (this.database.prepare(`${SELECT} ORDER BY created_at DESC, subscription_id DESC LIMIT ?`)
      .all(limit) as unknown as Row[]).map(mapRow);
  }

  public listDue(limit = 100): RunSubscription[] {
    requireLimit(limit);
    return (this.database.prepare(`${SELECT} WHERE status != 'completed'
      ORDER BY updated_at ASC, subscription_id ASC LIMIT ?`)
      .all(limit) as unknown as Row[]).map(mapRow);
  }

  public checkpointInTransaction(
    subscriptionId: string,
    observedKey: string | null,
    runtimeIdentity: string | null,
    at: string
  ): RunSubscription {
    this.requireTransaction();
    requireRunSubscriptionId(subscriptionId);
    this.database.prepare(`
      UPDATE run_subscriptions
      SET observed_key = ?, runtime_identity = ?, updated_at = ?
      WHERE subscription_id = ?
    `).run(observedKey, runtimeIdentity, timestamp(at), subscriptionId);
    return this.require(subscriptionId);
  }

  public setStatusInTransaction(
    subscriptionId: string,
    status: RunMonitorStatus,
    error: string | null,
    at: string
  ): RunSubscription {
    this.requireTransaction();
    requireRunSubscriptionId(subscriptionId);
    if (!["active", "blocked", "completed"].includes(status)) {
      throw new Error("invalid Run Subscription status");
    }
    this.database.prepare(`
      UPDATE run_subscriptions SET status = ?, latest_error = ?, updated_at = ?
      WHERE subscription_id = ?
    `).run(status, error, timestamp(at), subscriptionId);
    return this.require(subscriptionId);
  }

  private require(subscriptionId: string): RunSubscription {
    const subscription = this.get(subscriptionId);
    if (subscription === undefined) throw new Error(`Run Subscription ${subscriptionId} not found`);
    return subscription;
  }

  private requireTransaction(): void {
    if (!this.database.isTransaction) {
      throw new Error("Run Subscription writes require a caller-owned transaction");
    }
  }
}

export function runSubscriptionId(runId: string): string {
  requireLocalId(runId, "run", "runId");
  return `sub_run_${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

export const runMonitorSubscriptionId = runSubscriptionId;

export function requireRunSubscriptionId(value: string): string {
  if (!SUBSCRIPTION_ID.test(value)) {
    throw new Error("subscriptionId must be a sub_run_ identifier");
  }
  return value;
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("at must be an ISO timestamp");
  return new Date(value).toISOString();
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }
}

function mapRow(row: Row): RunSubscription {
  return {
    subscriptionId: row.subscription_id,
    runId: row.run_id,
    status: row.status,
    observedKey: row.observed_key,
    runtimeIdentity: row.runtime_identity,
    latestError: row.latest_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
