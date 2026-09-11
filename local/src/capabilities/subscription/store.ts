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
import { parseRunSourceBinding } from "../../modules/steward/source-contract.js";
import {
  type DeterministicApplicationActionRuntime,
  parseProactiveTarget,
  proactiveTargetRunBinding,
} from "../../modules/proactive/target.js";
import type {
  BoundSubscriptionDefinition,
  FreeSubscription,
  FreeSubscriptionDefinition,
  SubscriptionStatus,
  TargetedSubscriptionDefinition
} from "./model.js";
import type { PollObservation } from "./plugin-contract.js";
import {
  activateSubscriptionOccurrenceInTransaction,
  parseSubscriptionOccurrenceAdmissionReceipt,
  terminalRunStatus,
  type SubscriptionRunBindingAdapter
} from "./run-binding.js";

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
  definition_schema: FreeSubscription["definitionSchema"];
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
  source_binding_json: string | null;
  target_json: string | null;
  agent_run_id: string | null;
  cycle_id: string | null;
  admission_receipt_json: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export class SubscriptionStore {
  readonly #database: DatabaseSync;
  readonly #callbacks: CallbackStore;
  readonly #ownsDatabase: boolean;
  readonly #runBinding: SubscriptionRunBindingAdapter | undefined;
  readonly #actions: DeterministicApplicationActionRuntime | undefined;

  public constructor(
    databasePath: string | DatabaseSync,
    options: {
      readonly migrate?: boolean;
      readonly runBinding?: SubscriptionRunBindingAdapter;
      readonly applicationActions?: DeterministicApplicationActionRuntime;
    } = {}
  ) {
    this.#database = typeof databasePath === "string"
      ? openInitializedRuntimeDatabase(databasePath, migrateLocalDatabase)
      : databasePath;
    this.#ownsDatabase = typeof databasePath === "string";
    this.#callbacks = new CallbackStore(this.#database, options.migrate === undefined
      ? {}
      : { migrate: options.migrate });
    this.#runBinding = options.runBinding;
    this.#actions = options.applicationActions;
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

  public createBoundInTransaction(
    input: BoundSubscriptionDefinition & { readonly subscriptionId: string },
    createdAt = new Date().toISOString()
  ): FreeSubscription {
    validateBoundDefinition(input);
    const existing = this.boundForRun(input.sourceBinding.runId);
    if (existing !== undefined) {
      if (existing.definitionSchema !== "SubscriptionDefinition@4" ||
        existing.definitionRevision !== input.revision ||
        stableJson(existing.sourceBinding) !== stableJson(input.sourceBinding)) {
        throw new Error("Agent Run is already bound to another Subscription definition");
      }
      return existing;
    }
    requireLocalId(input.subscriptionId, "sub", "subscriptionId");
    const timestamp = iso(createdAt);
    const deadline = new Date(Date.parse(timestamp) + input.maxWaitMilliseconds).toISOString();
    const nextPoll = new Date(Date.parse(timestamp) + input.intervalMilliseconds).toISOString();
    const definitionDigest = sha256(stableJson({
      schemaVersion: input.schemaVersion,
      revision: input.revision,
      title: input.title.trim(),
      probe: input.probe,
      intervalMilliseconds: input.intervalMilliseconds,
      maxWaitMilliseconds: input.maxWaitMilliseconds,
      maxAttempts: input.maxAttempts,
      sourceBinding: input.sourceBinding,
      externalRefBinding: input.externalRefBinding ?? null
    }));
    this.#database.prepare(`
      INSERT INTO subscriptions (
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count, definition_schema,
        definition_revision, definition_digest, callback_phase_status, status,
        started_at, deadline_at, next_poll_at, external_ref_binding_json,
        source_binding_json, agent_run_id, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?, 0,
        'SubscriptionDefinition@4', ?, ?, 'pending', 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.subscriptionId, input.title.trim(), input.probe.plugin.path,
      input.probe.plugin.id,
      JSON.stringify({
        artifactRevision: input.probe.artifactRevision,
        artifactDigest: input.probe.artifactDigest,
        config: input.probe.plugin.config
      }),
      JSON.stringify(input.probe.policy), input.intervalMilliseconds,
      input.maxWaitMilliseconds, input.maxAttempts, input.revision,
      definitionDigest, timestamp, deadline, nextPoll,
      encodeExternalRefTriggerBinding(input.externalRefBinding),
      JSON.stringify(input.sourceBinding), input.sourceBinding.runId,
      timestamp, timestamp
    );
    return this.require(input.subscriptionId);
  }

  public createTargetedInTransaction(
    input: TargetedSubscriptionDefinition & { readonly subscriptionId: string },
    createdAt = new Date().toISOString()
  ): FreeSubscription {
    validateTargetedDefinition(input);
    requireLocalId(input.subscriptionId, "sub", "subscriptionId");
    const definitionDigest = sha256(stableJson({
      schemaVersion: input.schemaVersion,
      revision: input.revision,
      title: input.title.trim(),
      probe: input.probe,
      intervalMilliseconds: input.intervalMilliseconds,
      maxWaitMilliseconds: input.maxWaitMilliseconds,
      maxAttempts: input.maxAttempts,
      target: input.target,
      externalRefBinding: input.externalRefBinding ?? null
    }));
    const existingById = this.get(input.subscriptionId);
    if (existingById !== undefined) {
      if (existingById.definitionSchema === "SubscriptionDefinition@5" &&
        existingById.definitionDigest === definitionDigest) return existingById;
      throw new Error("Subscription ID is already bound to another definition");
    }
    const binding = proactiveTargetRunBinding(input.target);
    if (binding !== undefined) {
      const existing = this.boundForRun(binding.runId);
      if (existing !== undefined) {
        throw new Error("Agent Run is already bound to another Subscription definition");
      }
    }
    const timestamp = iso(createdAt);
    const deadline = new Date(Date.parse(timestamp) + input.maxWaitMilliseconds).toISOString();
    const nextPoll = new Date(Date.parse(timestamp) + input.intervalMilliseconds).toISOString();
    this.#database.prepare(`
      INSERT INTO subscriptions (
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count, definition_schema,
        definition_revision, definition_digest, callback_phase_status, status,
        started_at, deadline_at, next_poll_at, external_ref_binding_json,
        target_json, agent_run_id, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?, 0,
        'SubscriptionDefinition@5', ?, ?, 'pending', 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.subscriptionId, input.title.trim(), input.probe.plugin.path,
      input.probe.plugin.id,
      JSON.stringify({
        artifactRevision: input.probe.artifactRevision,
        artifactDigest: input.probe.artifactDigest,
        config: input.probe.plugin.config
      }),
      JSON.stringify(input.probe.policy), input.intervalMilliseconds,
      input.maxWaitMilliseconds, input.maxAttempts, input.revision,
      definitionDigest, timestamp, deadline, nextPoll,
      encodeExternalRefTriggerBinding(input.externalRefBinding),
      JSON.stringify(input.target), binding?.runId ?? null,
      timestamp, timestamp
    );
    return this.require(input.subscriptionId);
  }

  public boundForRun(runId: string): FreeSubscription | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM subscriptions
      WHERE definition_schema IN ('SubscriptionDefinition@4', 'SubscriptionDefinition@5')
        AND agent_run_id = ?
    `).get(runId) as SubscriptionRow | undefined;
    return row === undefined ? undefined : this.#map(row);
  }

  public get(subscriptionId: string): FreeSubscription | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM subscriptions
      WHERE subscription_id = ?
    `).get(subscriptionId) as SubscriptionRow | undefined;
    return row === undefined ? undefined : this.#map(row);
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
      SELECT * FROM subscriptions
      ORDER BY created_at DESC, subscription_id ASC
    `).all() as unknown as SubscriptionRow[]).map((row) => this.#map(row));
  }

  public setArchived(
    subscriptionId: string,
    archived: boolean,
    at = new Date().toISOString()
  ): { readonly subscription: FreeSubscription; readonly changed: boolean } {
    const current = this.require(subscriptionId);
    if (!["completed", "blocked", "cancelled", "expired"].includes(current.status)) {
      throw new Error(`Only terminal Subscriptions can be archived: ${subscriptionId}`);
    }
    if (archived === (current.archivedAt !== undefined)) {
      return { subscription: current, changed: false };
    }
    const changed = this.#database.prepare(`
      UPDATE subscriptions
      SET archived_at = ?
      WHERE subscription_id = ?
        AND ${archived ? "archived_at IS NULL" : "archived_at IS NOT NULL"}
    `).run(archived ? iso(at) : null, subscriptionId).changes;
    if (changed !== 1) {
      throw new Error(`Subscription archive update failed: ${subscriptionId}`);
    }
    return { subscription: this.require(subscriptionId), changed: true };
  }

  public due(now = new Date().toISOString(), limit = 20): FreeSubscription[] {
    const timestamp = iso(now);
    bounded(limit, 1, 100, "limit");
    this.#expireExhausted(timestamp);
    return (this.#database.prepare(`
      SELECT * FROM subscriptions
      WHERE status = 'active' AND julianday(next_poll_at) <= julianday(?)
        AND julianday(deadline_at) > julianday(?) AND attempt_count < max_attempts
      ORDER BY next_poll_at ASC, subscription_id ASC LIMIT ?
    `).all(timestamp, timestamp, limit) as unknown as SubscriptionRow[])
      .map((row) => this.#map(row));
  }

  public beginAttempt(
    subscriptionId: string,
    at = new Date().toISOString()
  ): FreeSubscription {
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

  public recordObservation(
    subscriptionId: string,
    observation: PollObservation,
    observedAt = new Date().toISOString(),
    freshnessEvidence: readonly string[] = []
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
          UPDATE subscriptions SET next_poll_at = ?, updated_at = ?
          WHERE subscription_id = ? AND status = 'active'
        `).run(
          new Date(Date.parse(timestamp) + subscription.intervalMilliseconds).toISOString(),
          timestamp, subscriptionId
        );
        if (exhausted) this.#expireInTransaction(subscription, timestamp);
      } else {
        const terminalKey = terminalOccurrenceKey(subscriptionId);
        const observationJson = terminalObservationJson(observation, terminalKey);
        if (subscription.definitionSchema === "SubscriptionDefinition@4" ||
          (subscription.definitionSchema === "SubscriptionDefinition@5" &&
            subscription.target?.kind === "steward_run")) {
          const binding = subscription.sourceBinding ??
            (subscription.target?.kind === "steward_run"
              ? subscription.target.sourceBinding
              : undefined);
          if (this.#runBinding === undefined || binding === undefined) {
            throw new Error("Subscription Steward Run target adapter is unavailable");
          }
          const receipt = activateSubscriptionOccurrenceInTransaction({
            adapter: this.#runBinding,
            binding,
            subscriptionId,
            occurrenceKey: terminalKey,
            observation: JSON.parse(observationJson) as unknown,
            freshnessEvidence: freshnessEvidence.length === 0
              ? [`subscription-definition:${subscription.definitionRevision}`]
              : freshnessEvidence,
            at: timestamp
          });
          this.#database.prepare(`
            UPDATE subscriptions SET status = 'completed', terminal_key = ?,
              terminal_observation_json = ?, callback_phase_status = 'running',
              cycle_id = ?, admission_receipt_json = ?, updated_at = ?
            WHERE subscription_id = ? AND status = 'active' AND terminal_key IS NULL
          `).run(
            terminalKey, observationJson, receipt.cycleId, JSON.stringify(receipt),
            timestamp, subscriptionId
          );
        } else if (subscription.definitionSchema === "SubscriptionDefinition@5" &&
          subscription.target?.kind === "application_action") {
          this.#completeActionInTransaction(subscription, observationJson, terminalKey, timestamp, "completed");
        } else {
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
      }
      return this.require(subscriptionId);
    });
  }

  public recordPollFailure(
    subscriptionId: string,
    error: string,
    at = new Date().toISOString()
  ): FreeSubscription {
    return withImmediateTransaction(this.#database, () => {
      const subscription = this.require(subscriptionId);
      if (subscription.status !== "active") return subscription;
      const timestamp = iso(at);
      const exhausted = subscription.attemptCount >= subscription.maxAttempts ||
        Date.parse(timestamp) >= Date.parse(subscription.deadlineAt);
      this.#database.prepare(`
        UPDATE subscriptions SET latest_error = ?, next_poll_at = ?, updated_at = ?
        WHERE subscription_id = ? AND status = 'active'
      `).run(error.slice(0, 4_096),
        new Date(Date.parse(timestamp) + subscription.intervalMilliseconds).toISOString(), timestamp, subscriptionId);
      if (exhausted) this.#expireInTransaction(this.require(subscriptionId), timestamp);
      return this.require(subscriptionId);
    });
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
      WHERE subscription_id = ? AND status = 'active'
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
      WHERE subscription_id = ? AND status IN (${placeholders})
    `).run(target[action], timestamp, target[action], timestamp,
      subscriptionId, ...allowed[action]);
    if (result.changes !== 1) throw new Error(`Subscription cannot ${action}: ${subscriptionId}`);
    return this.require(subscriptionId);
  }

  public reconcileBoundSources(at = new Date().toISOString()): string[] {
    if (this.#runBinding === undefined) return [];
    const timestamp = iso(at);
    const changed: string[] = [];
    const candidates = (this.#database.prepare(`
      SELECT subscription.*
      FROM subscriptions AS subscription
      LEFT JOIN agent_runs AS run ON run.run_id = subscription.agent_run_id
      WHERE subscription.definition_schema IN (
        'SubscriptionDefinition@4', 'SubscriptionDefinition@5'
      ) AND subscription.agent_run_id IS NOT NULL
        AND (
          (subscription.cycle_id IS NOT NULL
            AND subscription.callback_phase_status IN ('pending', 'running'))
          OR
          (subscription.status IN ('active', 'paused')
            AND run.status IN ('succeeded', 'failed', 'needs_human', 'cancelled'))
        )
      ORDER BY subscription.updated_at, subscription.subscription_id
      LIMIT 100
    `).all() as unknown as SubscriptionRow[]).map((row) => this.#map(row));
    for (const subscription of candidates) {
      const runId = subscription.agentRunId!;
      const run = this.#runBinding.runState(runId);
      if (run !== undefined && terminalRunStatus(run.status) &&
        (subscription.status === "active" || subscription.status === "paused")) {
        const binding = subscription.sourceBinding ??
          (subscription.target?.kind === "steward_run"
            ? subscription.target.sourceBinding
            : undefined);
        if (binding === undefined) continue;
        const action = binding.cancellationPolicy === "cancel_source"
          ? "cancel"
          : subscription.status === "active"
            ? "pause"
            : undefined;
        if (action !== undefined) {
          this.setStatus(subscription.subscriptionId, action, timestamp);
          changed.push(subscription.subscriptionId);
        }
        continue;
      }
      if (subscription.cycleId === undefined) continue;
      const cycle = this.#runBinding.cycleState(subscription.cycleId);
      if (cycle === undefined || cycle.status === "active") continue;
      const phase = cycle.status === "succeeded"
        ? "completed"
        : cycle.status === "failed"
          ? "completed_with_errors"
          : "completed_with_unknown";
      const error = phase === "completed"
        ? null
        : `run-cycle-${cycle.status}`;
      const update = this.#database.prepare(`
        UPDATE subscriptions
        SET callback_phase_status = ?, latest_error = ?, updated_at = ?
        WHERE subscription_id = ? AND definition_schema IN (
          'SubscriptionDefinition@4', 'SubscriptionDefinition@5'
        )
          AND cycle_id = ? AND callback_phase_status != ?
      `).run(
        phase, error, timestamp, subscription.subscriptionId,
        subscription.cycleId, phase
      );
      if (update.changes === 1) changed.push(subscription.subscriptionId);
    }
    return changed;
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
    this.#callbacks.close();
    if (this.#ownsDatabase) this.#database.close();
  }

  #completeActionInTransaction(subscription: FreeSubscription, observationJson: string, terminalKey: string, timestamp: string, status: "completed" | "expired"): void {
    if (subscription.target?.kind !== "application_action") throw new Error("Application action target required");
    const subscriptionId = subscription.subscriptionId;
    if (this.#actions === undefined) {
      throw new Error("Subscription application action target adapter is unavailable");
    }
    const receipt = this.#actions.executeInTransaction({
      target: subscription.target,
      source: {
        kind: "subscription",
        id: subscriptionId,
        definitionRevision: `SubscriptionDefinition@5:${subscription.definitionRevision}`
      },
      occurrenceKey: terminalKey,
      observation: JSON.parse(observationJson) as unknown,
      at: timestamp
    });
    this.#database.prepare(`
      UPDATE subscriptions SET status = ?, terminal_key = ?,
        terminal_observation_json = ?, callback_phase_status = ?,
        latest_error = ?, updated_at = ?
      WHERE subscription_id = ? AND status = 'active' AND terminal_key IS NULL
    `).run(
      receipt.status === "failed" ? "blocked" : status,
      terminalKey,
      observationJson,
      receipt.status === "failed" ? "completed_with_errors" : "completed",
      receipt.error ?? (status === "expired" ? subscription.latestError : undefined) ?? null,
      timestamp,
      subscriptionId
    );
  }

  #expireInTransaction(subscription: FreeSubscription, timestamp: string): void {
    if (subscription.target?.kind === "application_action") {
      const terminalKey = terminalOccurrenceKey(subscription.subscriptionId);
      const observationJson = terminalObservationJson({
        version: "SubscriptionExpiry@1", terminal: "failure",
        summary: "Subscription wait budget exhausted",
        facts: { status: "expired", reason: Date.parse(timestamp) >= Date.parse(subscription.deadlineAt)
          ? "deadline" : "max_attempts", attemptCount: subscription.attemptCount,
          ...(subscription.latestError === undefined ? {} : { latestError: subscription.latestError }) }
      }, terminalKey);
      this.#completeActionInTransaction(subscription, observationJson, terminalKey, timestamp, "expired");
    } else {
      this.#database.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE subscription_id = ? AND status = 'active'")
        .run(timestamp, subscription.subscriptionId);
    }
  }

  #expireExhausted(at: string): void {
    withImmediateTransaction(this.#database, () => {
      const rows = this.#database.prepare(`SELECT * FROM subscriptions WHERE status = 'active' AND (
        julianday(deadline_at) <= julianday(?) OR attempt_count >= max_attempts
      ) ORDER BY deadline_at, subscription_id LIMIT 100`).all(at) as unknown as SubscriptionRow[];
      for (const row of rows) this.#expireInTransaction(this.#map(row), at);
    });
  }

  #map(row: SubscriptionRow): FreeSubscription {
    const subscription = mapSubscription(row);
    if (subscription.definitionSchema !== "SubscriptionDefinition@5" ||
      subscription.target?.kind !== "application_action" ||
      subscription.terminalKey === undefined || this.#actions === undefined) {
      return subscription;
    }
    const receipt = this.#actions.receipt({
      kind: "subscription",
      id: subscription.subscriptionId,
      definitionRevision: `SubscriptionDefinition@5:${subscription.definitionRevision}`
    }, subscription.terminalKey);
    return receipt === undefined ? subscription : { ...subscription, actionReceipt: receipt };
  }
}

function mapSubscription(row: SubscriptionRow): FreeSubscription {
  const pluginSnapshot = JSON.parse(row.plugin_config_json) as {
    artifactRevision: string;
    artifactDigest: string;
    config: unknown;
  };
  const externalRefBinding = decodeExternalRefTriggerBinding(row.external_ref_binding_json);
  const sourceBinding = row.source_binding_json === null
    ? undefined
    : parseRunSourceBinding(JSON.parse(row.source_binding_json) as unknown);
  const target = row.target_json === null
    ? undefined
    : parseProactiveTarget(JSON.parse(row.target_json) as unknown, {
        kind: "subscription",
        id: row.subscription_id,
        definitionRevision: `SubscriptionDefinition@5:${row.definition_revision}`
      });
  const admissionReceipt = row.admission_receipt_json === null
    ? undefined
    : parseSubscriptionOccurrenceAdmissionReceipt(
        JSON.parse(row.admission_receipt_json) as unknown
      );
  return {
    subscriptionId: row.subscription_id,
    definitionSchema: row.definition_schema,
    definitionRevision: row.definition_revision,
    definitionDigest: row.definition_digest,
    title: row.title,
    ...(row.owner_agent_id === null ? {} : {
      ownerAgentId: requireNonEmpty(row.owner_agent_id, "ownerAgentId")
    }),
    ...(sourceBinding === undefined ? {} : { sourceBinding }),
    ...(target === undefined ? {} : { target }),
    ...(row.agent_run_id === null ? {} : { agentRunId: row.agent_run_id }),
    ...(row.cycle_id === null ? {} : { cycleId: row.cycle_id }),
    ...(admissionReceipt === undefined ? {} : { admissionReceipt }),
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
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
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

function validateBoundDefinition(
  input: BoundSubscriptionDefinition & { readonly subscriptionId: string }
): void {
  if (input.schemaVersion !== "SubscriptionDefinition@4") {
    throw new Error("SubscriptionDefinition@4 schemaVersion is required");
  }
  validateDefinitionBase(input);
  const binding = parseRunSourceBinding(input.sourceBinding);
  if (binding.source.kind !== "subscription" || binding.source.id !== input.subscriptionId ||
    binding.source.definitionRevision !== `SubscriptionDefinition@4:${input.revision}`) {
    throw new Error("SubscriptionDefinition@4 source binding is inconsistent");
  }
}

function validateTargetedDefinition(
  input: TargetedSubscriptionDefinition & { readonly subscriptionId: string }
): void {
  if (input.schemaVersion !== "SubscriptionDefinition@5") {
    throw new Error("SubscriptionDefinition@5 schemaVersion is required");
  }
  validateDefinitionBase(input);
  const target = parseProactiveTarget(input.target, {
    kind: "subscription",
    id: input.subscriptionId,
    definitionRevision: `SubscriptionDefinition@5:${input.revision}`
  });
  const binding = proactiveTargetRunBinding(target);
  if (binding !== undefined && binding.occurrencePolicy !== "one_shot") {
    throw new Error("SubscriptionDefinition@5 target must be one_shot");
  }
}

function validateDefinition(input: FreeSubscriptionDefinition): void {
  if (input.schemaVersion !== 3) throw new Error("schemaVersion must be 3");
  validateDefinitionBase(input);
  requireRuntimeId(input.ownerAgentId, "prn", "ownerAgentId");
  if (input.callbacks.length > 16) throw new Error("callbacks must contain at most 16 items");
  const ids = new Set<string>();
  for (const callback of input.callbacks) {
    requireLocalId(callback.callbackId, "scb", "callback.callbackId");
    if (ids.has(callback.callbackId)) throw new Error(`Duplicate callbackId: ${callback.callbackId}`);
    ids.add(callback.callbackId);
    validateProactiveCallback(callback);
  }
}

function validateDefinitionBase(input:
  | FreeSubscriptionDefinition
  | BoundSubscriptionDefinition
  | TargetedSubscriptionDefinition
): void {
  requireNonEmpty(input.revision, "revision");
  const title = requireNonEmpty(input.title, "title");
  if (title.length > 120) throw new Error("title must be at most 120 characters");
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

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
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
