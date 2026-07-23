import type { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { newEventId } from "../../core/event/model.js";
import { requireRuntimeId, runtimeId, runtimeRoute } from "../../core/runtime/model.js";
import type {
  CreatePollSubscription,
  PollSubscription,
  SubscriptionStatus
} from "./model.js";
import type { PollObservation } from "./plugin-contract.js";

interface SubscriptionRow {
  subscription_id: string;
  plugin_path: string;
  plugin_id: string;
  plugin_schema_version: 1;
  plugin_config_json: string;
  policy_json: string;
  interval_ms: number;
  max_wait_ms: number;
  max_attempts: number;
  attempt_count: number;
  callback_session_id: string;
  callback_prompt: string;
  status: SubscriptionStatus;
  started_at: string;
  deadline_at: string;
  next_poll_at: string;
  latest_error: string | null;
  fire_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordPollObservationResult {
  readonly subscription: PollSubscription;
  readonly fireEventId?: string;
}

export class PollSubscriptionStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = openRuntimeDatabase(databasePath);
    this.#migrate();
  }

  public create(
    input: CreatePollSubscription,
    createdAt = new Date().toISOString()
  ): PollSubscription {
    validateCreate(input);
    const at = iso(createdAt);
    const deadline = new Date(Date.parse(at) + input.maxWaitMilliseconds).toISOString();
    this.#database.prepare(`
      INSERT INTO poll_subscriptions (
        subscription_id, plugin_path, plugin_id, plugin_schema_version,
        plugin_config_json, policy_json, interval_ms, max_wait_ms, max_attempts,
        attempt_count, callback_session_id, callback_prompt, status, started_at,
        deadline_at, next_poll_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      input.subscriptionId,
      input.pluginPath,
      input.pluginId,
      input.pluginSchemaVersion,
      JSON.stringify(input.pluginConfig),
      JSON.stringify(input.policy),
      input.intervalMilliseconds,
      input.maxWaitMilliseconds,
      input.maxAttempts,
      input.callback.sessionId,
      input.callback.prompt,
      at,
      deadline,
      at,
      at,
      at
    );
    return this.require(input.subscriptionId);
  }

  public get(subscriptionId: string): PollSubscription | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM poll_subscriptions WHERE subscription_id = ?
    `).get(subscriptionId) as SubscriptionRow | undefined;
    return row === undefined ? undefined : mapSubscription(row);
  }

  public require(subscriptionId: string): PollSubscription {
    const subscription = this.get(subscriptionId);
    if (subscription === undefined) throw new Error(`Subscription not found: ${subscriptionId}`);
    return subscription;
  }

  public list(): PollSubscription[] {
    return (this.#database.prepare(`
      SELECT * FROM poll_subscriptions ORDER BY created_at DESC, subscription_id ASC
    `).all() as unknown as SubscriptionRow[]).map(mapSubscription);
  }

  public due(now = new Date().toISOString(), limit = 20): PollSubscription[] {
    const at = iso(now);
    bounded(limit, 1, 100, "limit");
    this.#expireExhausted(at);
    return (this.#database.prepare(`
      SELECT * FROM poll_subscriptions
      WHERE status = 'active' AND julianday(next_poll_at) <= julianday(?)
        AND julianday(deadline_at) > julianday(?) AND attempt_count < max_attempts
      ORDER BY next_poll_at ASC, subscription_id ASC LIMIT ?
    `).all(at, at, limit) as unknown as SubscriptionRow[]).map(mapSubscription);
  }

  public beginAttempt(subscriptionId: string, at = new Date().toISOString()): PollSubscription {
    const timestamp = iso(at);
    const result = this.#database.prepare(`
      UPDATE poll_subscriptions SET attempt_count = attempt_count + 1,
        latest_error = NULL, updated_at = ?
      WHERE subscription_id = ? AND status = 'active'
        AND julianday(next_poll_at) <= julianday(?)
        AND julianday(deadline_at) > julianday(?) AND attempt_count < max_attempts
    `).run(timestamp, subscriptionId, timestamp, timestamp);
    if (result.changes !== 1) throw new Error(`Subscription is not due: ${subscriptionId}`);
    return this.require(subscriptionId);
  }

  public recordPollFailure(
    subscriptionId: string,
    error: string,
    at = new Date().toISOString()
  ): PollSubscription {
    const subscription = this.require(subscriptionId);
    const timestamp = iso(at);
    const exhausted = subscription.attemptCount >= subscription.maxAttempts ||
      Date.parse(timestamp) >= Date.parse(subscription.deadlineAt);
    this.#database.prepare(`
      UPDATE poll_subscriptions SET status = ?, latest_error = ?, next_poll_at = ?, updated_at = ?
      WHERE subscription_id = ? AND status = 'active'
    `).run(
      exhausted ? "expired" : "active",
      error.slice(0, 4_096),
      nextPoll(subscription, timestamp),
      timestamp,
      subscriptionId
    );
    return this.require(subscriptionId);
  }

  public recordObservation(
    subscriptionId: string,
    observation: PollObservation,
    observedAt = new Date().toISOString()
  ): RecordPollObservationResult {
    validateObservation(observation);
    const timestamp = iso(observedAt);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const subscription = this.require(subscriptionId);
      if (subscription.status !== "active") {
        this.#database.exec("COMMIT");
        return {
          subscription,
          ...(subscription.fireEventId === undefined
            ? {}
            : { fireEventId: subscription.fireEventId })
        };
      }
      if (observation.terminal === null) {
        const exhausted = subscription.attemptCount >= subscription.maxAttempts ||
          Date.parse(timestamp) >= Date.parse(subscription.deadlineAt);
        this.#database.prepare(`
          UPDATE poll_subscriptions SET status = ?, next_poll_at = ?, updated_at = ?
          WHERE subscription_id = ? AND status = 'active'
        `).run(
          exhausted ? "expired" : "active",
          nextPoll(subscription, timestamp),
          timestamp,
          subscriptionId
        );
      } else {
        const session = this.#database.prepare(`
          SELECT agent_id FROM sessions WHERE session_id = ?
        `).get(subscription.callback.sessionId) as { agent_id: string } | undefined;
        if (session === undefined) {
          throw new Error(`Subscription Session not found: ${subscription.callback.sessionId}`);
        }
        const existing = this.#database.prepare(`
          SELECT event_id FROM events
          WHERE source_kind = 'subscription' AND source_external_id = ?
        `).get(subscriptionId) as { event_id: string } | undefined;
        const fireEventId = existing?.event_id ?? newEventId();
        if (existing === undefined) {
          const executionId = runtimeId("exe");
          const route = runtimeRoute("subscription.fire");
          this.#database.prepare(`
            INSERT INTO events (
              event_id, type, source_kind, source_external_id, agent_id, prompt,
              session_id, destination_ids_json, root_event_id, parent_event_id, causal_hop, created_at
            ) VALUES (?, 'subscription.fire', 'subscription', ?, ?, ?, ?, '[]', ?, NULL, 0, ?)
          `).run(
            fireEventId,
            subscriptionId,
            session.agent_id,
            subscription.callback.prompt,
            subscription.callback.sessionId,
            fireEventId,
            timestamp
          );
          this.#database.prepare(`
            INSERT INTO executions (
              execution_id, event_id, handler, status, attempt_count, max_attempts,
              next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'queued', 0, 3, ?, ?, ?)
          `).run(executionId, fireEventId, route.handler, timestamp, timestamp, timestamp);
        }
        this.#database.prepare(`
          UPDATE poll_subscriptions SET status = 'completed', fire_event_id = ?, updated_at = ?
          WHERE subscription_id = ? AND status = 'active'
        `).run(fireEventId, timestamp, subscriptionId);
      }
      this.#database.exec("COMMIT");
      const recorded = this.require(subscriptionId);
      return {
        subscription: recorded,
        ...(recorded.fireEventId === undefined ? {} : { fireEventId: recorded.fireEventId })
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public reconcileInterrupted(): number {
    return 0;
  }

  public setStatus(
    subscriptionId: string,
    action: "pause" | "resume" | "cancel" | "revoke",
    at = new Date().toISOString()
  ): PollSubscription {
    const allowed: Readonly<Record<typeof action, readonly SubscriptionStatus[]>> = {
      pause: ["active"],
      resume: ["paused"],
      cancel: ["active", "paused"],
      revoke: ["active", "paused"]
    };
    const target: Readonly<Record<typeof action, SubscriptionStatus>> = {
      pause: "paused",
      resume: "active",
      cancel: "cancelled",
      revoke: "revoked"
    };
    const placeholders = allowed[action].map(() => "?").join(",");
    const timestamp = iso(at);
    const result = this.#database.prepare(`
      UPDATE poll_subscriptions SET status = ?, updated_at = ?,
        next_poll_at = CASE WHEN ? = 'active' THEN ? ELSE next_poll_at END
      WHERE subscription_id = ? AND status IN (${placeholders})
    `).run(target[action], timestamp, target[action], timestamp, subscriptionId, ...allowed[action]);
    if (result.changes !== 1) throw new Error(`Subscription cannot ${action}: ${subscriptionId}`);
    return this.require(subscriptionId);
  }

  public close(): void {
    this.#database.close();
  }

  #expireExhausted(at: string): void {
    this.#database.prepare(`
      UPDATE poll_subscriptions SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND (
        julianday(deadline_at) <= julianday(?) OR attempt_count >= max_attempts
      )
    `).run(at, at);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS poll_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        plugin_path TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_schema_version INTEGER NOT NULL CHECK(plugin_schema_version = 1),
        plugin_config_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        max_wait_ms INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        callback_session_id TEXT NOT NULL REFERENCES sessions(session_id),
        callback_prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'active','paused','completed','cancelled','expired','revoked'
        )),
        started_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        next_poll_at TEXT NOT NULL,
        latest_error TEXT,
        fire_event_id TEXT UNIQUE REFERENCES events(event_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS poll_subscriptions_due
        ON poll_subscriptions(status, next_poll_at);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '20')
        ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), 20);
    `);
  }
}

function mapSubscription(row: SubscriptionRow): PollSubscription {
  return {
    subscriptionId: row.subscription_id,
    pluginPath: row.plugin_path,
    pluginId: row.plugin_id,
    pluginSchemaVersion: row.plugin_schema_version,
    pluginConfig: JSON.parse(row.plugin_config_json) as unknown,
    policy: JSON.parse(row.policy_json) as PollSubscription["policy"],
    intervalMilliseconds: row.interval_ms,
    maxWaitMilliseconds: row.max_wait_ms,
    maxAttempts: row.max_attempts,
    callback: {
      sessionId: row.callback_session_id,
      prompt: row.callback_prompt
    },
    status: row.status,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    nextPollAt: row.next_poll_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.latest_error === null ? {} : { latestError: row.latest_error }),
    ...(row.fire_event_id === null ? {} : { fireEventId: row.fire_event_id })
  };
}

function validateCreate(input: CreatePollSubscription): void {
  requireNonEmpty(input.subscriptionId, "subscriptionId");
  requireNonEmpty(input.pluginPath, "pluginPath");
  requireNonEmpty(input.pluginId, "pluginId");
  requireRuntimeId(input.callback.sessionId, "ses", "callback.sessionId");
  requireNonEmpty(input.callback.prompt, "callback.prompt");
  bounded(input.intervalMilliseconds, 100, 86_400_000, "intervalMilliseconds");
  bounded(input.maxWaitMilliseconds, input.intervalMilliseconds, 31 * 86_400_000,
    "maxWaitMilliseconds");
  bounded(input.maxAttempts, 1, 100_000, "maxAttempts");
}

function validateObservation(observation: PollObservation): void {
  if (observation.terminal !== null && observation.terminal !== "success" &&
    observation.terminal !== "failure" && observation.terminal !== "cancelled") {
    throw new Error("observation.terminal is invalid");
  }
}

function nextPoll(subscription: PollSubscription, at: string): string {
  return new Date(Date.parse(at) + subscription.intervalMilliseconds).toISOString();
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function iso(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error("timestamp must be ISO-8601");
  return new Date(parsed).toISOString();
}
