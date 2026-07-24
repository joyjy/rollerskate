import type { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { newEventId } from "../../core/event/model.js";
import { localId } from "../../core/id.js";
import { requireRuntimeId, runtimeId, runtimeRoute } from "../../core/runtime/model.js";
import type {
  CreatePollSubscription,
  PollSubscription,
  SubscriptionStatus
} from "./model.js";
import type { PollObservation } from "./plugin-contract.js";

interface SubscriptionRow {
  subscription_id: string;
  owner_agent_id: string | null;
  plugin_path: string;
  plugin_id: string;
  plugin_schema_version: 1;
  plugin_config_json: string;
  policy_json: string;
  interval_ms: number;
  max_wait_ms: number;
  max_attempts: number;
  attempt_count: number;
  callback_provider_session_id: string;
  callback_adapter_id: string;
  callback_workspace: string;
  callback_session_id: string | null;
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
    const subscriptionId = localId("sub");
    const at = iso(createdAt);
    const deadline = new Date(Date.parse(at) + input.maxWaitMilliseconds).toISOString();
    const firstPollAt = new Date(Date.parse(at) + input.intervalMilliseconds).toISOString();
    this.#database.prepare(`
      INSERT INTO poll_subscriptions (
        subscription_id, owner_agent_id, plugin_path, plugin_id, plugin_schema_version,
        plugin_config_json, policy_json, interval_ms, max_wait_ms, max_attempts,
        attempt_count, callback_provider_session_id, callback_adapter_id,
        callback_workspace, callback_session_id, callback_prompt, status,
        started_at, deadline_at, next_poll_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      subscriptionId,
      input.ownerAgentId,
      input.pluginPath,
      input.pluginId,
      input.pluginSchemaVersion,
      JSON.stringify(input.pluginConfig),
      JSON.stringify(input.policy),
      input.intervalMilliseconds,
      input.maxWaitMilliseconds,
      input.maxAttempts,
      input.callback.providerSessionId,
      input.callback.adapterId,
      input.callback.workspace,
      input.callback.localSessionId ?? null,
      input.callback.prompt,
      at,
      deadline,
      firstPollAt,
      at,
      at
    );
    return this.require(subscriptionId);
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
        const sessionId = this.#materializeCallbackSession(subscription, timestamp);
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
            subscription.ownerAgentId,
            subscription.callback.prompt,
            sessionId,
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
    action: "pause" | "resume" | "cancel",
    at = new Date().toISOString()
  ): PollSubscription {
    const allowed: Readonly<Record<typeof action, readonly SubscriptionStatus[]>> = {
      pause: ["active"],
      resume: ["paused"],
      cancel: ["active", "paused"]
    };
    const target: Readonly<Record<typeof action, SubscriptionStatus>> = {
      pause: "paused",
      resume: "active",
      cancel: "cancelled"
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

  #materializeCallbackSession(
    subscription: PollSubscription,
    at: string
  ): string {
    const row = this.#database.prepare(`
      SELECT session_id, agent_id, workspace
      FROM sessions
      WHERE adapter_id = ? AND provider_session_id = ?
    `).get(
      subscription.callback.adapterId,
      subscription.callback.providerSessionId
    ) as {
      session_id: string;
      agent_id: string;
      workspace: string;
    } | undefined;
    if (row !== undefined) {
      if (row.agent_id !== subscription.ownerAgentId ||
        row.workspace !== subscription.callback.workspace ||
        (subscription.callback.localSessionId !== undefined &&
          subscription.callback.localSessionId !== row.session_id)) {
        throw new Error(
          `Subscription callback provider Session belongs to another target: ` +
          subscription.callback.providerSessionId
        );
      }
      this.#database.prepare(`
        UPDATE sessions SET updated_at = ? WHERE session_id = ?
      `).run(at, row.session_id);
      this.#database.prepare(`
        UPDATE poll_subscriptions SET callback_session_id = ? WHERE subscription_id = ?
      `).run(row.session_id, subscription.subscriptionId);
      return row.session_id;
    }
    if (subscription.callback.localSessionId !== undefined) {
      throw new Error(
        `Subscription callback Local Session is missing: ` +
        subscription.callback.localSessionId
      );
    }
    const sessionId = runtimeId("ses");
    this.#database.prepare(`
      INSERT INTO sessions (
        session_id, agent_id, adapter_id, provider_session_id, workspace,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      subscription.ownerAgentId,
      subscription.callback.adapterId,
      subscription.callback.providerSessionId,
      subscription.callback.workspace,
      at,
      at
    );
    this.#database.prepare(`
      UPDATE poll_subscriptions SET callback_session_id = ? WHERE subscription_id = ?
    `).run(sessionId, subscription.subscriptionId);
    return sessionId;
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
        owner_agent_id TEXT NOT NULL REFERENCES local_principals(principal_id),
        plugin_path TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_schema_version INTEGER NOT NULL CHECK(plugin_schema_version = 1),
        plugin_config_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        max_wait_ms INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        callback_provider_session_id TEXT NOT NULL,
        callback_adapter_id TEXT NOT NULL,
        callback_workspace TEXT NOT NULL,
        callback_session_id TEXT REFERENCES sessions(session_id),
        callback_prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'active','paused','completed','cancelled','expired'
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
    `);
    const columns = this.#database.prepare("PRAGMA table_info(poll_subscriptions)")
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "owner_agent_id")) {
      this.#database.exec(`
        ALTER TABLE poll_subscriptions ADD COLUMN owner_agent_id TEXT;
        UPDATE poll_subscriptions
        SET owner_agent_id = (
          SELECT sessions.agent_id
          FROM sessions
          WHERE sessions.session_id = poll_subscriptions.callback_session_id
        );
      `);
    }
    if (!columns.some((column) => column.name === "callback_provider_session_id")) {
      this.#database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        ALTER TABLE poll_subscriptions RENAME TO poll_subscriptions_v33;
        CREATE TABLE poll_subscriptions (
          subscription_id TEXT PRIMARY KEY,
          owner_agent_id TEXT NOT NULL REFERENCES local_principals(principal_id),
          plugin_path TEXT NOT NULL,
          plugin_id TEXT NOT NULL,
          plugin_schema_version INTEGER NOT NULL CHECK(plugin_schema_version = 1),
          plugin_config_json TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          interval_ms INTEGER NOT NULL,
          max_wait_ms INTEGER NOT NULL,
          max_attempts INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          callback_provider_session_id TEXT NOT NULL,
          callback_adapter_id TEXT NOT NULL,
          callback_workspace TEXT NOT NULL,
          callback_session_id TEXT REFERENCES sessions(session_id),
          callback_prompt TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'active','paused','completed','cancelled','expired'
          )),
          started_at TEXT NOT NULL,
          deadline_at TEXT NOT NULL,
          next_poll_at TEXT NOT NULL,
          latest_error TEXT,
          fire_event_id TEXT UNIQUE REFERENCES events(event_id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO poll_subscriptions (
          subscription_id, owner_agent_id, plugin_path, plugin_id,
          plugin_schema_version, plugin_config_json, policy_json, interval_ms,
          max_wait_ms, max_attempts, attempt_count,
          callback_provider_session_id, callback_adapter_id, callback_workspace,
          callback_session_id, callback_prompt, status, started_at, deadline_at,
          next_poll_at, latest_error, fire_event_id, created_at, updated_at
        )
        SELECT
          old.subscription_id, old.owner_agent_id, old.plugin_path, old.plugin_id,
          old.plugin_schema_version, old.plugin_config_json, old.policy_json,
          old.interval_ms, old.max_wait_ms, old.max_attempts, old.attempt_count,
          session.provider_session_id, session.adapter_id, session.workspace,
          old.callback_session_id, old.callback_prompt, old.status,
          old.started_at, old.deadline_at, old.next_poll_at, old.latest_error,
          old.fire_event_id, old.created_at, old.updated_at
        FROM poll_subscriptions_v33 AS old
        JOIN sessions AS session ON session.session_id = old.callback_session_id;
        DROP TABLE poll_subscriptions_v33;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    }
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS poll_subscriptions_due
        ON poll_subscriptions(status, next_poll_at);
    `);
    this.#database.exec(`
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '34')
        ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), 34);
    `);
  }
}

function mapSubscription(row: SubscriptionRow): PollSubscription {
  return {
    subscriptionId: row.subscription_id,
    ownerAgentId: requireNonEmpty(row.owner_agent_id ?? "", "ownerAgentId"),
    pluginPath: row.plugin_path,
    pluginId: row.plugin_id,
    pluginSchemaVersion: row.plugin_schema_version,
    pluginConfig: JSON.parse(row.plugin_config_json) as unknown,
    policy: JSON.parse(row.policy_json) as PollSubscription["policy"],
    intervalMilliseconds: row.interval_ms,
    maxWaitMilliseconds: row.max_wait_ms,
    maxAttempts: row.max_attempts,
    callback: {
      providerSessionId: row.callback_provider_session_id,
      adapterId: row.callback_adapter_id,
      workspace: row.callback_workspace,
      ...(row.callback_session_id === null
        ? {}
        : { localSessionId: row.callback_session_id }),
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
  requireRuntimeId(input.ownerAgentId, "prn", "ownerAgentId");
  requireNonEmpty(input.pluginPath, "pluginPath");
  requireNonEmpty(input.pluginId, "pluginId");
  requireNonEmpty(input.callback.providerSessionId, "callback.providerSessionId");
  requireNonEmpty(input.callback.adapterId, "callback.adapterId");
  requireNonEmpty(input.callback.workspace, "callback.workspace");
  if (input.callback.localSessionId !== undefined) {
    requireRuntimeId(input.callback.localSessionId, "ses", "callback.localSessionId");
  }
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
