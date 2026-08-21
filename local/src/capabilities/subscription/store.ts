import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { localId, requireLocalId } from "../../core/id.js";
import { requireRuntimeId } from "../../core/runtime/model.js";
import { openInitializedRuntimeDatabase } from
  "../../infrastructure/sqlite/database.js";
import { migrateLocalDatabase } from "../../infrastructure/sqlite/schema/index.js";
import { withImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
import { CallbackStore } from "../../infrastructure/callback/store.js";
import { validateProactiveCallback } from "../../modules/callback/proactive-model.js";
import {
  decodeExternalRefTriggerBinding,
  encodeExternalRefTriggerBinding,
  parseExternalRefTriggerBinding
} from "../../modules/external-resource/trigger-binding.js";
import type { FreeSubscription, FreeSubscriptionDefinition, SubscriptionStatus } from "./model.js";
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
  definition_schema: "SubscriptionDefinition@3";
  definition_revision: string;
  definition_digest: string;
  callback_phase_status: FreeSubscription["callbackPhaseStatus"];
  terminal_key: string | null;
  terminal_observation_json: string | null;
  status: SubscriptionStatus;
  started_at: string;
  deadline_at: string;
  next_poll_at: string;
  latest_error: string | null;
  external_ref_binding_json: string | null;
  created_at: string;
  updated_at: string;
}

export class SubscriptionStore {
  readonly #database: DatabaseSync;
  readonly #callbacks: CallbackStore;

  public constructor(databasePath: string) {
    this.#database = openInitializedRuntimeDatabase(databasePath, migrateLocalDatabase);
    this.#callbacks = new CallbackStore(this.#database);
  }

  public create(
    input: FreeSubscriptionDefinition,
    createdAt = new Date().toISOString()
  ): FreeSubscription {
    validateDefinition(input);
    const grantDigest = sha256(stableJson(input.callbacks.map(({ grant }) => grant)));
    if (input.approvedGrantDigest !== grantDigest) {
      throw new Error(`approvedGrantDigest must equal ${grantDigest}`);
    }
    const subscriptionId = localId("sub");
    const timestamp = iso(createdAt);
    const deadline = new Date(Date.parse(timestamp) + input.maxWaitMilliseconds).toISOString();
    const nextPoll = new Date(Date.parse(timestamp) + input.intervalMilliseconds).toISOString();
    const definitionDigest = sha256(stableJson({
      schemaVersion: input.schemaVersion,
      revision: input.revision,
      title: input.title.trim(),
      ownerAgentId: input.ownerAgentId,
      probe: input.probe,
      intervalMilliseconds: input.intervalMilliseconds,
      maxWaitMilliseconds: input.maxWaitMilliseconds,
      maxAttempts: input.maxAttempts,
      callbacks: input.callbacks,
      externalRefBinding: input.externalRefBinding ?? null
    }));
    return withImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        INSERT INTO subscriptions (
          subscription_id, title, owner_agent_id, plugin_path, plugin_id,
          plugin_schema_version, plugin_config_json, policy_json, interval_ms,
          max_wait_ms, max_attempts, attempt_count, definition_schema,
          definition_revision, definition_digest, callback_phase_status, status,
          started_at, deadline_at, next_poll_at, external_ref_binding_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0,
          'SubscriptionDefinition@3', ?, ?, 'pending', 'active', ?, ?, ?, ?, ?, ?)
      `).run(
        subscriptionId, input.title.trim(), input.ownerAgentId,
        input.probe.plugin.path, input.probe.plugin.id,
        JSON.stringify({
          artifactRevision: input.probe.artifactRevision,
          artifactDigest: input.probe.artifactDigest,
          config: input.probe.plugin.config
        }),
        JSON.stringify(input.probe.policy), input.intervalMilliseconds,
        input.maxWaitMilliseconds, input.maxAttempts, input.revision,
        definitionDigest, timestamp, deadline, nextPoll,
        encodeExternalRefTriggerBinding(input.externalRefBinding),
        timestamp, timestamp
      );
      this.#callbacks.registerDefinitionsInTransaction({
        kind: "subscription",
        id: subscriptionId,
        revision: 1
      }, input.callbacks, timestamp);
      return this.require(subscriptionId);
    });
  }

  public get(subscriptionId: string): FreeSubscription | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM subscriptions
      WHERE subscription_id = ? AND definition_schema = 'SubscriptionDefinition@3'
    `).get(subscriptionId) as SubscriptionRow | undefined;
    return row === undefined ? undefined : mapSubscription(row);
  }

  public require(subscriptionId: string): FreeSubscription {
    const subscription = this.get(subscriptionId);
    if (subscription === undefined) {
      throw new Error(`Subscription not found: ${subscriptionId}`);
    }
    return subscription;
  }

  public list(): FreeSubscription[] {
    return (this.#database.prepare(`
      SELECT * FROM subscriptions WHERE definition_schema = 'SubscriptionDefinition@3'
      ORDER BY created_at DESC, subscription_id ASC
    `).all() as unknown as SubscriptionRow[]).map(mapSubscription);
  }

  public due(now = new Date().toISOString(), limit = 20): FreeSubscription[] {
    const timestamp = iso(now);
    bounded(limit, 1, 100, "limit");
    this.#expireExhausted(timestamp);
    return (this.#database.prepare(`
      SELECT * FROM subscriptions
      WHERE definition_schema = 'SubscriptionDefinition@3'
        AND status = 'active' AND julianday(next_poll_at) <= julianday(?)
        AND julianday(deadline_at) > julianday(?) AND attempt_count < max_attempts
      ORDER BY next_poll_at ASC, subscription_id ASC LIMIT ?
    `).all(timestamp, timestamp, limit) as unknown as SubscriptionRow[])
      .map(mapSubscription);
  }

  public beginAttempt(
    subscriptionId: string,
    at = new Date().toISOString()
  ): FreeSubscription {
    const timestamp = iso(at);
    const result = this.#database.prepare(`
      UPDATE subscriptions SET attempt_count = attempt_count + 1,
        latest_error = NULL, updated_at = ?
      WHERE subscription_id = ? AND definition_schema = 'SubscriptionDefinition@3'
        AND status = 'active' AND julianday(next_poll_at) <= julianday(?)
        AND julianday(deadline_at) > julianday(?) AND attempt_count < max_attempts
    `).run(timestamp, subscriptionId, timestamp, timestamp);
    if (result.changes !== 1) throw new Error(`Subscription is not due: ${subscriptionId}`);
    return this.require(subscriptionId);
  }

  public recordObservation(
    subscriptionId: string,
    observation: PollObservation,
    observedAt = new Date().toISOString()
  ): FreeSubscription {
    validateObservation(observation);
    const timestamp = iso(observedAt);
    return withImmediateTransaction(this.#database, () => {
      const subscription = this.require(subscriptionId);
      if (subscription.status !== "active") {
        return subscription;
      }
      if (observation.terminal === null) {
        const exhausted = subscription.attemptCount >= subscription.maxAttempts ||
          Date.parse(timestamp) >= Date.parse(subscription.deadlineAt);
        this.#database.prepare(`
          UPDATE subscriptions SET status = ?, next_poll_at = ?, updated_at = ?
          WHERE subscription_id = ? AND status = 'active'
        `).run(
          exhausted ? "expired" : "active",
          new Date(Date.parse(timestamp) + subscription.intervalMilliseconds).toISOString(),
          timestamp, subscriptionId
        );
      } else {
        const terminalKey = terminalOccurrenceKey(subscriptionId);
        const observationJson = terminalObservationJson(observation, terminalKey);
        const owner = { kind: "subscription" as const, id: subscriptionId, revision: 1 };
        const count = this.#callbacks.definitions(owner).length;
        this.#database.prepare(`
          UPDATE subscriptions SET status = 'completed', terminal_key = ?,
            terminal_observation_json = ?, callback_phase_status = ?, updated_at = ?
          WHERE subscription_id = ? AND status = 'active' AND terminal_key IS NULL
        `).run(
          terminalKey, observationJson, count === 0 ? "completed" : "pending",
          timestamp, subscriptionId
        );
        if (count > 0) {
          this.#callbacks.materializeInTransaction(owner, terminalKey, timestamp);
        }
      }
      return this.require(subscriptionId);
    });
  }

  public recordPollFailure(
    subscriptionId: string,
    error: string,
    at = new Date().toISOString()
  ): FreeSubscription {
    const subscription = this.require(subscriptionId);
    const timestamp = iso(at);
    const exhausted = subscription.attemptCount >= subscription.maxAttempts ||
      Date.parse(timestamp) >= Date.parse(subscription.deadlineAt);
    this.#database.prepare(`
      UPDATE subscriptions SET status = ?, latest_error = ?, next_poll_at = ?, updated_at = ?
      WHERE subscription_id = ? AND status = 'active'
    `).run(
      exhausted ? "expired" : "active", error.slice(0, 4_096),
      new Date(Date.parse(timestamp) + subscription.intervalMilliseconds).toISOString(),
      timestamp, subscriptionId
    );
    return this.require(subscriptionId);
  }

  public blockExternalRefTrigger(
    subscriptionId: string,
    reason: string,
    at = new Date().toISOString()
  ): FreeSubscription {
    const timestamp = iso(at);
    const result = this.#database.prepare(`
      UPDATE subscriptions
      SET status = 'blocked', callback_phase_status = 'blocked', latest_error = ?, updated_at = ?
      WHERE subscription_id = ? AND definition_schema = 'SubscriptionDefinition@3'
        AND status = 'active'
    `).run(`external-ref-trigger:${reason}`.slice(0, 4_096), timestamp, subscriptionId);
    if (result.changes !== 1) return this.require(subscriptionId);
    return this.require(subscriptionId);
  }

  public setStatus(
    subscriptionId: string,
    action: "pause" | "resume" | "cancel",
    at = new Date().toISOString()
  ): FreeSubscription {
    const allowed: Readonly<Record<typeof action, readonly SubscriptionStatus[]>> = {
      pause: ["active"], resume: ["paused"], cancel: ["active", "paused"]
    };
    const target: Readonly<Record<typeof action, SubscriptionStatus>> = {
      pause: "paused", resume: "active", cancel: "cancelled"
    };
    const placeholders = allowed[action].map(() => "?").join(",");
    const timestamp = iso(at);
    const result = this.#database.prepare(`
      UPDATE subscriptions SET status = ?, updated_at = ?,
        next_poll_at = CASE WHEN ? = 'active' THEN ? ELSE next_poll_at END
      WHERE subscription_id = ? AND definition_schema = 'SubscriptionDefinition@3'
        AND status IN (${placeholders})
    `).run(target[action], timestamp, target[action], timestamp,
      subscriptionId, ...allowed[action]);
    if (result.changes !== 1) throw new Error(`Subscription cannot ${action}: ${subscriptionId}`);
    return this.require(subscriptionId);
  }

  public reconcileCallbacks(at = new Date().toISOString()): number {
    const timestamp = iso(at);
    const rows = this.#database.prepare(`
      SELECT subscription.subscription_id,
        SUM(CASE WHEN callback.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN callback.status = 'started' THEN 1 ELSE 0 END) AS started,
        SUM(CASE WHEN callback.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN callback.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN callback.status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count
      FROM subscriptions AS subscription
      JOIN proactive_callback_occurrences AS callback
        ON callback.owner_kind = 'subscription'
        AND callback.owner_id = subscription.subscription_id
      WHERE subscription.terminal_key IS NOT NULL
      GROUP BY subscription.subscription_id
    `).all() as unknown as Array<{
      subscription_id: string;
      pending: number;
      started: number;
      failed: number;
      blocked: number;
      unknown_count: number;
    }>;
    let changed = 0;
    for (const row of rows) {
      const active = row.pending + row.started;
      const phase = active > 0
        ? row.started > 0 ? "running" : "pending"
        : row.unknown_count > 0
          ? "completed_with_unknown"
          : row.blocked > 0
            ? "blocked"
            : row.failed > 0
              ? "completed_with_errors"
              : "completed";
      changed += Number(this.#database.prepare(`
        UPDATE subscriptions
        SET callback_phase_status = ?,
          status = CASE WHEN ? = 'blocked' THEN 'blocked' ELSE status END,
          updated_at = ?
        WHERE subscription_id = ? AND callback_phase_status != ?
      `).run(phase, phase, timestamp, row.subscription_id, phase).changes);
    }
    return changed;
  }

  public close(): void {
    this.#database.close();
  }

  #expireExhausted(at: string): void {
    this.#database.prepare(`
      UPDATE subscriptions SET status = 'expired', updated_at = ?
      WHERE definition_schema = 'SubscriptionDefinition@3' AND status = 'active' AND (
        julianday(deadline_at) <= julianday(?) OR attempt_count >= max_attempts
      )
    `).run(at, at);
  }
}

function mapSubscription(row: SubscriptionRow): FreeSubscription {
  const pluginSnapshot = JSON.parse(row.plugin_config_json) as {
    artifactRevision: string;
    artifactDigest: string;
    config: unknown;
  };
  const externalRefBinding = decodeExternalRefTriggerBinding(row.external_ref_binding_json);
  return {
    subscriptionId: row.subscription_id,
    definitionSchema: row.definition_schema,
    definitionRevision: row.definition_revision,
    definitionDigest: row.definition_digest,
    title: row.title,
    ownerAgentId: requireNonEmpty(row.owner_agent_id ?? "", "ownerAgentId"),
    probe: {
      plugin: {
        path: row.plugin_path,
        id: row.plugin_id,
        schemaVersion: row.plugin_schema_version,
        config: pluginSnapshot.config
      },
      policy: JSON.parse(row.policy_json) as FreeSubscription["probe"]["policy"],
      artifactRevision: pluginSnapshot.artifactRevision,
      artifactDigest: pluginSnapshot.artifactDigest
    },
    ...(externalRefBinding === undefined ? {} : { externalRefBinding }),
    intervalMilliseconds: row.interval_ms,
    maxWaitMilliseconds: row.max_wait_ms,
    maxAttempts: row.max_attempts,
    attemptCount: row.attempt_count,
    status: row.status,
    callbackPhaseStatus: row.callback_phase_status,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    nextPollAt: row.next_poll_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.latest_error === null ? {} : { latestError: row.latest_error }),
    ...(row.terminal_key === null ? {} : { terminalKey: row.terminal_key }),
    ...(row.terminal_observation_json === null
      ? {}
      : { terminalObservation: JSON.parse(row.terminal_observation_json) as unknown })
  };
}

function validateDefinition(input: FreeSubscriptionDefinition): void {
  if (input.schemaVersion !== 3) throw new Error("schemaVersion must be 3");
  requireNonEmpty(input.revision, "revision");
  const title = requireNonEmpty(input.title, "title");
  if (title.length > 120) throw new Error("title must be at most 120 characters");
  requireRuntimeId(input.ownerAgentId, "prn", "ownerAgentId");
  requireNonEmpty(input.probe.plugin.path, "probe.plugin.path");
  requireNonEmpty(input.probe.plugin.id, "probe.plugin.id");
  requireNonEmpty(input.probe.artifactRevision, "probe.artifactRevision");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.probe.artifactDigest)) {
    throw new Error("probe.artifactDigest must be sha256:<64 lowercase hex>");
  }
  bounded(input.intervalMilliseconds, 100, 86_400_000, "intervalMilliseconds");
  bounded(input.maxWaitMilliseconds, input.intervalMilliseconds, 31 * 86_400_000,
    "maxWaitMilliseconds");
  bounded(input.maxAttempts, 1, 100_000, "maxAttempts");
  if (input.externalRefBinding !== undefined) {
    parseExternalRefTriggerBinding(input.externalRefBinding);
  }
  if (input.callbacks.length > 16) throw new Error("callbacks must contain at most 16 items");
  const ids = new Set<string>();
  for (const callback of input.callbacks) {
    requireLocalId(callback.callbackId, "scb", "callback.callbackId");
    if (ids.has(callback.callbackId)) throw new Error(`Duplicate callbackId: ${callback.callbackId}`);
    ids.add(callback.callbackId);
    validateProactiveCallback(callback);
  }
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

function terminalObservationJson(observation: PollObservation, terminalKey: string): string {
  if (observation.terminal === null) throw new Error("terminal observation is required");
  let encoded: string;
  try {
    encoded = JSON.stringify({
      version: observation.version,
      terminalKey,
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

function terminalOccurrenceKey(subscriptionId: string): string {
  return `subscription:${subscriptionId}:terminal`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
