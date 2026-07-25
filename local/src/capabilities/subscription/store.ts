import type { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { migrateLocalDatabase } from "../../infrastructure/sqlite/local-schema.js";
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
  title: string;
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
      INSERT INTO subscriptions (
        subscription_id, title, owner_agent_id, plugin_path, plugin_id, plugin_schema_version,
        plugin_config_json, policy_json, interval_ms, max_wait_ms, max_attempts,
        attempt_count, callback_provider_session_id, callback_adapter_id,
        callback_workspace, callback_session_id, callback_prompt, status,
        started_at, deadline_at, next_poll_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      subscriptionId,
      input.title.trim(),
      input.ownerAgentId,
      input.probe.plugin.path,
      input.probe.plugin.id,
      input.probe.plugin.schemaVersion,
      JSON.stringify(input.probe.plugin.config),
      JSON.stringify(input.probe.policy),
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
      SELECT * FROM subscriptions WHERE subscription_id = ?
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
      SELECT * FROM subscriptions ORDER BY created_at DESC, subscription_id ASC
    `).all() as unknown as SubscriptionRow[]).map(mapSubscription);
  }

  public due(now = new Date().toISOString(), limit = 20): PollSubscription[] {
    const at = iso(now);
    bounded(limit, 1, 100, "limit");
    this.#expireExhausted(at);
    return (this.#database.prepare(`
      SELECT * FROM subscriptions
      WHERE status = 'active' AND julianday(next_poll_at) <= julianday(?)
        AND julianday(deadline_at) > julianday(?) AND attempt_count < max_attempts
      ORDER BY next_poll_at ASC, subscription_id ASC LIMIT ?
    `).all(at, at, limit) as unknown as SubscriptionRow[]).map(mapSubscription);
  }

  public beginAttempt(subscriptionId: string, at = new Date().toISOString()): PollSubscription {
    const timestamp = iso(at);
    const result = this.#database.prepare(`
      UPDATE subscriptions SET attempt_count = attempt_count + 1,
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
      UPDATE subscriptions SET status = ?, latest_error = ?, next_poll_at = ?, updated_at = ?
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
          UPDATE subscriptions SET status = ?, next_poll_at = ?, updated_at = ?
          WHERE subscription_id = ? AND status = 'active'
        `).run(
          exhausted ? "expired" : "active",
          nextPoll(subscription, timestamp),
          timestamp,
          subscriptionId
        );
      } else {
        const observationJson = terminalObservationJson(observation);
        const sessionId = this.#materializeCallbackSession(subscription, timestamp);
        const existing = this.#database.prepare(`
          SELECT event_id FROM events
          WHERE source_kind = 'subscription' AND source_external_id = ?
        `).get(subscriptionId) as { event_id: string } | undefined;
        const fireEventId = existing?.event_id ?? newEventId();
        if (existing === undefined) {
          const destinationId = runtimeId("dst");
          const executionId = runtimeId("exe");
          const route = runtimeRoute("subscription.fire");
          const destination = {
            destinationId,
            kind: "macos-notification",
            address: {
              title: subscription.title,
              subscriptionId: subscription.subscriptionId,
              callbackAdapterId: subscription.callback.adapterId,
              providerSessionId: subscription.callback.providerSessionId
            },
            createdAt: timestamp,
            updatedAt: timestamp
          };
          this.#database.prepare(`
            INSERT INTO events (
              event_id, type, source_kind, source_external_id, agent_id, prompt,
              payload_json, session_id, destination_ids_json,
              destination_snapshots_json, root_event_id, parent_event_id,
              causal_hop, created_at
            ) VALUES (?, 'subscription.fire', 'subscription', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)
          `).run(
            fireEventId,
            subscriptionId,
            subscription.ownerAgentId,
            subscription.callback.prompt,
            observationJson,
            sessionId,
            JSON.stringify([destinationId]),
            JSON.stringify([destination]),
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
          UPDATE subscriptions SET status = 'completed', fire_event_id = ?, updated_at = ?
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
      UPDATE subscriptions SET status = ?, updated_at = ?,
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
      FROM agent_sessions
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
        UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?
      `).run(at, row.session_id);
      this.#database.prepare(`
        UPDATE subscriptions SET callback_session_id = ? WHERE subscription_id = ?
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
      INSERT INTO agent_sessions (
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
      UPDATE subscriptions SET callback_session_id = ? WHERE subscription_id = ?
    `).run(sessionId, subscription.subscriptionId);
    return sessionId;
  }

  #expireExhausted(at: string): void {
    this.#database.prepare(`
      UPDATE subscriptions SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND (
        julianday(deadline_at) <= julianday(?) OR attempt_count >= max_attempts
      )
    `).run(at, at);
  }

  #migrate(): void {
    migrateLocalDatabase(this.#database);
  }
}

function mapSubscription(row: SubscriptionRow): PollSubscription {
  return {
    subscriptionId: row.subscription_id,
    title: row.title,
    ownerAgentId: requireNonEmpty(row.owner_agent_id ?? "", "ownerAgentId"),
    probe: {
      plugin: {
        path: row.plugin_path,
        id: row.plugin_id,
        schemaVersion: row.plugin_schema_version,
        config: JSON.parse(row.plugin_config_json) as unknown
      },
      policy: JSON.parse(row.policy_json) as PollSubscription["probe"]["policy"]
    },
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
  const title = requireNonEmpty(input.title, "title");
  if (title.length > 120) throw new Error("title must be at most 120 characters");
  requireRuntimeId(input.ownerAgentId, "prn", "ownerAgentId");
  requireNonEmpty(input.probe.plugin.path, "probe.plugin.path");
  requireNonEmpty(input.probe.plugin.id, "probe.plugin.id");
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
  requireNonEmpty(observation.version, "observation.version");
  if (typeof observation.facts !== "object" || observation.facts === null ||
    Array.isArray(observation.facts)) {
    throw new Error("observation.facts must be an object");
  }
  if (observation.terminal !== null && observation.terminal !== "success" &&
    observation.terminal !== "failure" && observation.terminal !== "cancelled") {
    throw new Error("observation.terminal is invalid");
  }
  if (observation.summary !== undefined) {
    requireNonEmpty(observation.summary, "observation.summary");
  }
}

function terminalObservationJson(observation: PollObservation): string {
  if (observation.terminal === null) {
    throw new Error("terminal observation is required for subscription.fire");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify({
      version: observation.version,
      facts: observation.facts,
      terminal: observation.terminal,
      ...(observation.summary === undefined ? {} : { summary: observation.summary })
    });
  } catch (error) {
    throw new Error(`terminal observation must be JSON-serializable: ${message(error)}`);
  }
  if (Buffer.byteLength(encoded, "utf8") > 16_384) {
    throw new Error("terminal observation exceeds 16384 bytes");
  }
  return encoded;
}

function nextPoll(subscription: PollSubscription, at: string): string {
  return new Date(Date.parse(at) + subscription.intervalMilliseconds).toISOString();
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
