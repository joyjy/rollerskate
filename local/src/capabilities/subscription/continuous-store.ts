import type { DatabaseSync } from "node:sqlite";

import { localId, requireLocalId } from "../../core/id.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { openInitializedRuntimeDatabase } from
  "../../infrastructure/sqlite/database.js";
import { migrateLocalDatabase } from "../../infrastructure/sqlite/schema/index.js";
import { withImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
import { CallbackStore } from "../../infrastructure/callback/store.js";
import {
  decodeExternalRefTriggerBinding,
  encodeExternalRefTriggerBinding,
  parseExternalRefTriggerBinding
} from "../../modules/external-resource/trigger-binding.js";
import {
  mapProactiveCallbackOccurrence,
  type ProactiveCallbackDefinition,
  type ProactiveCallbackOccurrence,
  type ProactiveCallbackOccurrenceRow
} from "../../modules/callback/proactive-model.js";
import { parseRunSourceBinding } from "../../modules/steward/source-contract.js";
import type { PollObservation } from "./plugin-contract.js";
import type {
  BoundContinuousSubscriptionDefinition,
  ContinuousSubscription,
  ContinuousSubscriptionDefinition,
  LegacyContinuousSubscriptionDefinition
} from "./continuous-model.js";
import {
  activateSubscriptionOccurrenceInTransaction,
  parseSubscriptionOccurrenceAdmissionReceipt,
  terminalRunStatus,
  type SubscriptionRunBindingAdapter
} from "./run-binding.js";

interface Row {
  readonly subscription_id: string;
  readonly title: string;
  readonly owner_agent_id: string | null;
  readonly current_revision: number;
  readonly definition_schema: ContinuousSubscriptionDefinition["schemaVersion"];
  readonly plugin_path: string;
  readonly plugin_id: string;
  readonly plugin_config_json: string;
  readonly policy_json: string;
  readonly interval_ms: number;
  readonly poll_count: number;
  readonly status: ContinuousSubscription["status"];
  readonly next_poll_at: string;
  readonly checkpoint_occurrence_key: string | null;
  readonly checkpoint_observation_json: string | null;
  readonly pending_occurrence_key: string | null;
  readonly pending_observation_json: string | null;
  readonly latest_error: string | null;
  readonly external_ref_binding_json: string | null;
  readonly source_binding_json: string | null;
  readonly agent_run_id: string | null;
  readonly pending_cycle_id: string | null;
  readonly pending_admission_receipt_json: string | null;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export class ContinuousSubscriptionStore {
  readonly #database: DatabaseSync;
  readonly #callbacks: CallbackStore;
  readonly #runtime: RuntimeStore;
  readonly #ownsDatabase: boolean;
  readonly #runBinding: SubscriptionRunBindingAdapter | undefined;

  public constructor(
    databasePath: string | DatabaseSync,
    options: {
      readonly migrate?: boolean;
      readonly runBinding?: SubscriptionRunBindingAdapter;
    } = {}
  ) {
    this.#database = typeof databasePath === "string"
      ? openInitializedRuntimeDatabase(databasePath, migrateLocalDatabase)
      : databasePath;
    this.#ownsDatabase = typeof databasePath === "string";
    const nestedOptions = options.migrate === undefined ? {} : { migrate: options.migrate };
    this.#callbacks = new CallbackStore(this.#database, nestedOptions);
    this.#runtime = new RuntimeStore(this.#database, nestedOptions);
    this.#runBinding = options.runBinding;
  }

  public create(
    definition: LegacyContinuousSubscriptionDefinition,
    at = new Date().toISOString()
  ): ContinuousSubscription {
    validateDefinition(definition);
    const subscriptionId = localId("sub");
    const timestamp = iso(at);
    const nextPollAt = new Date(Date.parse(timestamp) + definition.intervalMilliseconds)
      .toISOString();
    withImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        INSERT INTO continuous_subscriptions (
          subscription_id, title, owner_agent_id, current_revision,
          plugin_path, plugin_id, plugin_config_json, policy_json,
          interval_ms, poll_count, status, next_poll_at, external_ref_binding_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)
      `).run(
        subscriptionId,
        definition.title.trim(),
        definition.ownerAgentId,
        definition.revision,
        definition.probe.plugin.path,
        definition.probe.plugin.id,
        boundedJson(definition.probe.plugin.config, "plugin config"),
        boundedJson(definition.probe.policy, "probe policy"),
        definition.intervalMilliseconds,
        nextPollAt,
        encodeExternalRefTriggerBinding(definition.externalRefBinding),
        timestamp,
        timestamp
      );
      this.#callbacks.registerDefinitionsInTransaction({
        kind: "continuous_subscription",
        id: subscriptionId,
        revision: definition.revision
      }, definition.callbacks, timestamp);
    });
    return this.require(subscriptionId);
  }

  public createBoundInTransaction(
    input: BoundContinuousSubscriptionDefinition & { readonly subscriptionId: string },
    at = new Date().toISOString()
  ): ContinuousSubscription {
    validateBoundDefinition(input);
    const existing = this.boundForRun(input.sourceBinding.runId);
    if (existing !== undefined) {
      if (existing.definition.schemaVersion !== "ContinuousSubscriptionDefinition@2" ||
        existing.definition.revision !== input.revision ||
        boundedJson(existing.definition.sourceBinding, "source binding") !==
          boundedJson(input.sourceBinding, "source binding")) {
        throw new Error("Agent Run is already bound to another Continuous Subscription");
      }
      return existing;
    }
    requireLocalId(input.subscriptionId, "sub", "subscriptionId");
    const timestamp = iso(at);
    const nextPollAt = new Date(Date.parse(timestamp) + input.intervalMilliseconds)
      .toISOString();
    this.#database.prepare(`
      INSERT INTO continuous_subscriptions (
        subscription_id, title, owner_agent_id, current_revision, definition_schema,
        plugin_path, plugin_id, plugin_config_json, policy_json, interval_ms,
        poll_count, status, next_poll_at, external_ref_binding_json,
        source_binding_json, agent_run_id, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 'ContinuousSubscriptionDefinition@2', ?, ?, ?, ?, ?,
        0, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      input.subscriptionId, input.title.trim(), input.revision,
      input.probe.plugin.path, input.probe.plugin.id,
      boundedJson(input.probe.plugin.config, "plugin config"),
      boundedJson(input.probe.policy, "probe policy"),
      input.intervalMilliseconds, nextPollAt,
      encodeExternalRefTriggerBinding(input.externalRefBinding),
      boundedJson(input.sourceBinding, "source binding"), input.sourceBinding.runId,
      timestamp, timestamp
    );
    return this.require(input.subscriptionId);
  }

  public boundForRun(runId: string): ContinuousSubscription | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM continuous_subscriptions
      WHERE definition_schema = 'ContinuousSubscriptionDefinition@2'
        AND agent_run_id = ?
    `).get(runId) as Row | undefined;
    return row === undefined ? undefined : this.#map(row);
  }

  public require(subscriptionId: string): ContinuousSubscription {
    const subscription = this.get(subscriptionId);
    if (subscription === undefined) {
      throw new Error(`Continuous Subscription not found: ${subscriptionId}`);
    }
    return subscription;
  }

  public get(subscriptionId: string): ContinuousSubscription | undefined {
    requireLocalId(subscriptionId, "sub", "subscriptionId");
    const row = this.#database.prepare(`
      SELECT * FROM continuous_subscriptions WHERE subscription_id = ?
    `).get(subscriptionId) as Row | undefined;
    return row === undefined ? undefined : this.#map(row);
  }

  public list(limit = 100): ContinuousSubscription[] {
    boundedLimit(limit, 1, 100, "limit");
    return this.#mapRows(this.#database.prepare(`
      SELECT * FROM continuous_subscriptions
      ORDER BY created_at DESC, subscription_id LIMIT ?
    `).all(limit) as unknown as Row[]);
  }

  public setArchived(
    subscriptionId: string,
    archived: boolean,
    at = new Date().toISOString()
  ): ContinuousSubscription {
    const current = this.require(subscriptionId);
    if (current.status !== "cancelled") {
      throw new Error(
        `Continuous Subscription cannot ${archived ? "archive" : "unarchive"} ` +
        `from ${current.status}`
      );
    }
    if ((current.archivedAt !== undefined) === archived) return current;
    this.#database.prepare(`
      UPDATE continuous_subscriptions SET archived_at = ? WHERE subscription_id = ?
    `).run(archived ? iso(at) : null, subscriptionId);
    return this.require(subscriptionId);
  }

  public visibleCallbacks(
    subscriptionIds: readonly string[]
  ): ReadonlyMap<string, readonly ProactiveCallbackOccurrence[]> {
    if (subscriptionIds.length > 100) throw new Error("subscriptionIds exceeds 100 items");
    const result = new Map<string, ProactiveCallbackOccurrence[]>();
    for (const subscriptionId of subscriptionIds) {
      requireLocalId(subscriptionId, "sub", "subscriptionId");
      result.set(subscriptionId, []);
    }
    if (subscriptionIds.length === 0) return result;
    const placeholders = subscriptionIds.map(() => "?").join(", ");
    const rows = this.#database.prepare(`
      SELECT occurrence.*
      FROM continuous_subscriptions AS subscription
      JOIN proactive_callback_occurrences AS occurrence
        ON occurrence.owner_kind = 'continuous_subscription'
        AND occurrence.owner_id = subscription.subscription_id
        AND occurrence.trigger_occurrence_key = COALESCE(
          subscription.pending_occurrence_key,
          subscription.checkpoint_occurrence_key
        )
      WHERE subscription.subscription_id IN (${placeholders})
      ORDER BY subscription.subscription_id, occurrence.ordinal
      LIMIT 6400
    `).all(...subscriptionIds) as unknown as ProactiveCallbackOccurrenceRow[];
    for (const row of rows) {
      result.get(row.owner_id)!.push(mapProactiveCallbackOccurrence(row));
    }
    return result;
  }

  public due(now = new Date().toISOString(), limit = 20): ContinuousSubscription[] {
    const timestamp = iso(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be between 1 and 100");
    }
    return this.#mapRows(this.#database.prepare(`
      SELECT * FROM continuous_subscriptions
      WHERE status = 'active' AND pending_occurrence_key IS NULL
        AND julianday(next_poll_at) <= julianday(?)
      ORDER BY next_poll_at, subscription_id LIMIT ?
    `).all(timestamp, limit) as unknown as Row[]);
  }

  public beginPoll(subscriptionId: string, at: string): ContinuousSubscription {
    const timestamp = iso(at);
    const changed = this.#database.prepare(`
      UPDATE continuous_subscriptions
      SET poll_count = poll_count + 1, latest_error = NULL, updated_at = ?
      WHERE subscription_id = ? AND status = 'active'
        AND pending_occurrence_key IS NULL AND julianday(next_poll_at) <= julianday(?)
    `).run(timestamp, subscriptionId, timestamp).changes;
    if (changed !== 1) throw new Error(`Continuous Subscription is not due: ${subscriptionId}`);
    return this.require(subscriptionId);
  }

  public recordObservation(
    subscriptionId: string,
    observation: PollObservation,
    at = new Date().toISOString(),
    freshnessEvidence: readonly string[] = []
  ): { readonly subscription: ContinuousSubscription; readonly delta: boolean } {
    const occurrenceKey = text(observation.occurrenceKey, "observation.occurrenceKey", 512);
    const timestamp = iso(at);
    const observationJson = boundedJson(observation, "continuous observation");
    return withImmediateTransaction(this.#database, () => {
      const current = this.require(subscriptionId);
      if (current.status !== "active") throw new Error("Continuous Subscription is not active");
      if (current.pendingOccurrenceKey !== undefined &&
        current.pendingOccurrenceKey !== occurrenceKey) {
        throw new Error("Continuous Subscription already has a pending occurrence");
      }
      if (current.pendingOccurrenceKey === occurrenceKey) {
        if (boundedJson(current.pendingObservation, "pending observation") !==
          observationJson) {
          throw new Error("Continuous occurrence key is already bound to another observation");
        }
        return { subscription: current, delta: true };
      }
      const delta = current.checkpointOccurrenceKey !== occurrenceKey;
      if (!delta) {
        this.#database.prepare(`
          UPDATE continuous_subscriptions SET next_poll_at = ?, updated_at = ?
          WHERE subscription_id = ?
        `).run(nextPoll(current, timestamp), timestamp, subscriptionId);
      } else {
        this.#database.prepare(`
          UPDATE continuous_subscriptions
          SET pending_occurrence_key = ?, pending_observation_json = ?, updated_at = ?
          WHERE subscription_id = ? AND pending_occurrence_key IS NULL
        `).run(occurrenceKey, observationJson, timestamp, subscriptionId);
        if (current.definition.schemaVersion === "ContinuousSubscriptionDefinition@2") {
          if (this.#runBinding === undefined) {
            throw new Error(
              "ContinuousSubscriptionDefinition@2 Run binding adapter is unavailable"
            );
          }
          const receipt = activateSubscriptionOccurrenceInTransaction({
            adapter: this.#runBinding,
            binding: current.definition.sourceBinding,
            subscriptionId,
            occurrenceKey,
            observation,
            freshnessEvidence: freshnessEvidence.length === 0
              ? [`continuous-subscription-definition:${current.definition.revision}`]
              : freshnessEvidence,
            at: timestamp
          });
          this.#database.prepare(`
            UPDATE continuous_subscriptions
            SET pending_cycle_id = ?, pending_admission_receipt_json = ?, updated_at = ?
            WHERE subscription_id = ? AND pending_occurrence_key = ?
          `).run(
            receipt.cycleId, JSON.stringify(receipt), timestamp,
            subscriptionId, occurrenceKey
          );
        } else {
          this.#callbacks.materializeInTransaction({
            kind: "continuous_subscription",
            id: subscriptionId,
            revision: current.definition.revision
          }, occurrenceKey, timestamp);
        }
      }
      const result = this.require(subscriptionId);
      return { subscription: result, delta };
    });
  }

  public finalizeCallbacks(at = new Date().toISOString(), limit = 100): string[] {
    const timestamp = iso(at);
    boundedLimit(limit, 1, 100, "limit");
    const candidates = this.#database.prepare(`
      SELECT subscription.subscription_id, subscription.pending_occurrence_key,
        subscription.interval_ms,
        SUM(CASE WHEN occurrence.status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
        SUM(CASE WHEN occurrence.status IN ('failed', 'blocked') THEN 1 ELSE 0 END) AS error_count
      FROM continuous_subscriptions AS subscription
      JOIN proactive_callback_occurrences AS occurrence
        ON occurrence.owner_kind = 'continuous_subscription'
        AND occurrence.owner_id = subscription.subscription_id
        AND occurrence.trigger_occurrence_key = subscription.pending_occurrence_key
      WHERE subscription.pending_occurrence_key IS NOT NULL
      GROUP BY subscription.subscription_id, subscription.pending_occurrence_key,
        subscription.interval_ms
      HAVING COUNT(*) > 0
        AND SUM(CASE WHEN occurrence.status IN ('pending', 'started') THEN 1 ELSE 0 END) = 0
      ORDER BY subscription.updated_at, subscription.subscription_id
      LIMIT ?
    `).all(limit) as unknown as Array<{
      subscription_id: string;
      pending_occurrence_key: string;
      interval_ms: number;
      unknown_count: number;
      error_count: number;
    }>;
    const finalized: string[] = [];
    withImmediateTransaction(this.#database, () => {
      for (const candidate of candidates) {
        const error = candidate.unknown_count > 0
          ? "callback_outcome_unknown"
          : candidate.error_count > 0
            ? "callback_completed_with_errors"
            : null;
        const changed = this.#database.prepare(`
        UPDATE continuous_subscriptions
        SET checkpoint_occurrence_key = pending_occurrence_key,
          checkpoint_observation_json = pending_observation_json,
          pending_occurrence_key = NULL, pending_observation_json = NULL,
          latest_error = CASE WHEN $hasError = 1 THEN $error ELSE NULL END,
          next_poll_at = $nextPollAt, updated_at = $updatedAt
        WHERE subscription_id = $subscriptionId
          AND pending_occurrence_key = $pendingOccurrenceKey
        `).run({
          $hasError: error === null ? 0 : 1,
          $error: error ?? "",
          $nextPollAt: new Date(Date.parse(timestamp) + candidate.interval_ms).toISOString(),
          $updatedAt: timestamp,
          $subscriptionId: candidate.subscription_id,
          $pendingOccurrenceKey: candidate.pending_occurrence_key
        }).changes;
        if (changed === 1) finalized.push(candidate.subscription_id);
      }
    });
    return finalized;
  }

  public reconcileBoundOccurrences(at = new Date().toISOString()): string[] {
    if (this.#runBinding === undefined) return [];
    const timestamp = iso(at);
    const changed: string[] = [];
    const candidates = this.#mapRows(this.#database.prepare(`
      SELECT subscription.*
      FROM continuous_subscriptions AS subscription
      LEFT JOIN agent_runs AS run ON run.run_id = subscription.agent_run_id
      WHERE subscription.definition_schema = 'ContinuousSubscriptionDefinition@2'
        AND (
          (subscription.pending_cycle_id IS NOT NULL AND subscription.status = 'active')
          OR
          (subscription.status IN ('active', 'paused')
            AND run.status IN ('succeeded', 'failed', 'needs_human', 'cancelled'))
        )
      ORDER BY subscription.updated_at, subscription.subscription_id
      LIMIT 100
    `).all() as unknown as Row[]);
    for (const subscription of candidates) {
      const definition = subscription.definition as BoundContinuousSubscriptionDefinition;
      const run = this.#runBinding.runState(subscription.agentRunId!);
      if (run !== undefined && terminalRunStatus(run.status) &&
        (subscription.status === "active" || subscription.status === "paused")) {
        const action = definition.sourceBinding.cancellationPolicy === "cancel_source"
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
      if (subscription.pendingCycleId === undefined) continue;
      const cycle = this.#runBinding.cycleState(subscription.pendingCycleId);
      if (cycle === undefined) {
        const update = this.#database.prepare(`
          UPDATE continuous_subscriptions
          SET status = 'blocked', latest_error = 'run-cycle-missing', updated_at = ?
          WHERE subscription_id = ? AND status = 'active' AND pending_cycle_id = ?
        `).run(timestamp, subscription.subscriptionId, subscription.pendingCycleId);
        if (update.changes === 1) changed.push(subscription.subscriptionId);
        continue;
      }
      if (cycle.status === "active") continue;
      if (cycle.status !== "succeeded") {
        const update = this.#database.prepare(`
          UPDATE continuous_subscriptions
          SET status = 'blocked', latest_error = ?, updated_at = ?
          WHERE subscription_id = ? AND status = 'active' AND pending_cycle_id = ?
        `).run(
          `run-cycle-${cycle.status}`, timestamp,
          subscription.subscriptionId, subscription.pendingCycleId
        );
        if (update.changes === 1) changed.push(subscription.subscriptionId);
        continue;
      }
      const update = this.#database.prepare(`
        UPDATE continuous_subscriptions
        SET checkpoint_occurrence_key = pending_occurrence_key,
          checkpoint_observation_json = pending_observation_json,
          pending_occurrence_key = NULL, pending_observation_json = NULL,
          pending_cycle_id = NULL, pending_admission_receipt_json = NULL,
          latest_error = NULL, next_poll_at = ?, updated_at = ?
        WHERE subscription_id = ? AND status = 'active' AND pending_cycle_id = ?
      `).run(
        nextPoll(subscription, timestamp), timestamp,
        subscription.subscriptionId, subscription.pendingCycleId
      );
      if (update.changes === 1) changed.push(subscription.subscriptionId);
    }
    return changed;
  }

  public recordPollFailure(subscriptionId: string, error: string, at: string): void {
    const subscription = this.require(subscriptionId);
    const timestamp = iso(at);
    this.#database.prepare(`
      UPDATE continuous_subscriptions SET latest_error = ?, next_poll_at = ?, updated_at = ?
      WHERE subscription_id = ? AND status = 'active'
    `).run(error.slice(0, 4_096), nextPoll(subscription, timestamp), timestamp, subscriptionId);
  }

  public blockExternalRefTrigger(
    subscriptionId: string,
    reason: string,
    at = new Date().toISOString()
  ): ContinuousSubscription {
    const timestamp = iso(at);
    this.#database.prepare(`
      UPDATE continuous_subscriptions
      SET status = 'blocked', latest_error = ?, updated_at = ?
      WHERE subscription_id = ? AND status = 'active'
    `).run(`external-ref-trigger:${reason}`.slice(0, 4_096), timestamp, subscriptionId);
    return this.require(subscriptionId);
  }

  public setStatus(
    subscriptionId: string,
    action: "pause" | "resume" | "cancel",
    at = new Date().toISOString()
  ): ContinuousSubscription {
    const current = this.require(subscriptionId);
    const target = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
    const allowed = action === "pause"
      ? ["active"]
      : action === "resume"
        ? ["paused"]
        : ["active", "paused", "blocked"];
    if (current.status === target) return current;
    if (!allowed.includes(current.status)) {
      throw new Error(`Continuous Subscription cannot ${action} from ${current.status}`);
    }
    const timestamp = iso(at);
    withImmediateTransaction(this.#database, () => {
      if (action === "cancel" && current.pendingOccurrenceKey !== undefined) {
        const eventIds = this.#database.prepare(`
          SELECT event_id FROM proactive_callback_occurrences
          WHERE owner_kind = 'continuous_subscription' AND owner_id = ?
            AND trigger_occurrence_key = ? AND event_id IS NOT NULL
        `).all(subscriptionId, current.pendingOccurrenceKey) as unknown as
          Array<{ event_id: string }>;
        this.#runtime.failExecutionsForEventsInTransaction(
          eventIds.map(({ event_id }) => event_id),
          "subscription_cancelled",
          timestamp
        );
        this.#database.prepare(`
          UPDATE proactive_callback_occurrences
          SET status = 'unknown', last_error = 'subscription_cancelled',
            completed_at = ?, updated_at = ?
          WHERE owner_kind = 'continuous_subscription' AND owner_id = ?
            AND trigger_occurrence_key = ? AND status IN ('pending', 'started')
        `).run(timestamp, timestamp, subscriptionId, current.pendingOccurrenceKey);
      }
      this.#database.prepare(`
        UPDATE continuous_subscriptions SET status = ?, next_poll_at = ?, updated_at = ?
        WHERE subscription_id = ?
      `).run(
        target,
        action === "resume" ? timestamp : current.nextPollAt,
        timestamp,
        subscriptionId
      );
    });
    return this.require(subscriptionId);
  }

  public close(): void {
    this.#callbacks.close();
    if (this.#ownsDatabase) this.#database.close();
  }

  #mapRows(rows: readonly Row[]): ContinuousSubscription[] {
    const owners = rows.map((row) => ({
      kind: "continuous_subscription",
      id: row.subscription_id,
      revision: row.current_revision
    } as const));
    const definitions = this.#callbacks.definitionsForOwners(owners);
    return rows.map((row) => this.#map(
      row,
      definitions.get(ownerKey(row.subscription_id, row.current_revision)) ?? []
    ));
  }

  #map(
    row: Row,
    callbacks: readonly ProactiveCallbackDefinition[] = this.#callbacks.definitions({
      kind: "continuous_subscription",
      id: row.subscription_id,
      revision: row.current_revision
    })
  ): ContinuousSubscription {
    const externalRefBinding = decodeExternalRefTriggerBinding(row.external_ref_binding_json);
    const sourceBinding = row.source_binding_json === null
      ? undefined
      : parseRunSourceBinding(JSON.parse(row.source_binding_json) as unknown);
    const pendingAdmissionReceipt = row.pending_admission_receipt_json === null
      ? undefined
      : parseSubscriptionOccurrenceAdmissionReceipt(
          JSON.parse(row.pending_admission_receipt_json) as unknown
        );
    const definition: ContinuousSubscriptionDefinition = row.definition_schema ===
      "ContinuousSubscriptionDefinition@1"
      ? {
          schemaVersion: "ContinuousSubscriptionDefinition@1",
          revision: row.current_revision,
          title: row.title,
          ownerAgentId: row.owner_agent_id!,
          probe: {
            plugin: {
              path: row.plugin_path,
              id: row.plugin_id,
              config: JSON.parse(row.plugin_config_json) as unknown
            },
            policy: JSON.parse(row.policy_json) as
              LegacyContinuousSubscriptionDefinition["probe"]["policy"]
          },
          intervalMilliseconds: row.interval_ms,
          callbacks,
          ...(externalRefBinding === undefined ? {} : { externalRefBinding })
        }
      : {
          schemaVersion: "ContinuousSubscriptionDefinition@2",
          revision: row.current_revision,
          title: row.title,
          probe: {
            plugin: {
              path: row.plugin_path,
              id: row.plugin_id,
              config: JSON.parse(row.plugin_config_json) as unknown
            },
            policy: JSON.parse(row.policy_json) as
              BoundContinuousSubscriptionDefinition["probe"]["policy"]
          },
          intervalMilliseconds: row.interval_ms,
          sourceBinding: sourceBinding!,
          ...(externalRefBinding === undefined ? {} : { externalRefBinding })
        };
    return {
      subscriptionId: row.subscription_id,
      definition,
      status: row.status,
      ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
      pollCount: row.poll_count,
      nextPollAt: row.next_poll_at,
      ...(row.checkpoint_occurrence_key === null
        ? {}
        : { checkpointOccurrenceKey: row.checkpoint_occurrence_key }),
      ...(row.checkpoint_observation_json === null
        ? {}
        : { checkpointObservation: JSON.parse(row.checkpoint_observation_json) as PollObservation }),
      ...(row.pending_occurrence_key === null
        ? {}
        : { pendingOccurrenceKey: row.pending_occurrence_key }),
      ...(row.pending_observation_json === null
        ? {}
        : { pendingObservation: JSON.parse(row.pending_observation_json) as PollObservation }),
      ...(row.agent_run_id === null ? {} : { agentRunId: row.agent_run_id }),
      ...(row.pending_cycle_id === null ? {} : { pendingCycleId: row.pending_cycle_id }),
      ...(pendingAdmissionReceipt === undefined ? {} : { pendingAdmissionReceipt }),
      ...(row.latest_error === null ? {} : { latestError: row.latest_error }),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

function ownerKey(subscriptionId: string, revision: number): string {
  return `continuous_subscription\0${subscriptionId}\0${revision}`;
}

function boundedLimit(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateDefinition(definition: ContinuousSubscriptionDefinition): void {
  if (definition.schemaVersion !== "ContinuousSubscriptionDefinition@1") {
    throw new Error("continuous subscription schema is unsupported");
  }
  validateDefinitionBase(definition);
  requireLocalId(definition.ownerAgentId, "prn", "ownerAgentId");
  if (definition.callbacks.length === 0) throw new Error("callbacks must not be empty");
}

function validateBoundDefinition(
  definition: BoundContinuousSubscriptionDefinition & { readonly subscriptionId: string }
): void {
  if (definition.schemaVersion !== "ContinuousSubscriptionDefinition@2") {
    throw new Error("ContinuousSubscriptionDefinition@2 schemaVersion is required");
  }
  validateDefinitionBase(definition);
  const binding = parseRunSourceBinding(definition.sourceBinding);
  if (binding.source.kind !== "continuous_subscription" ||
    binding.source.id !== definition.subscriptionId ||
    binding.source.definitionRevision !==
      `ContinuousSubscriptionDefinition@2:${definition.revision}`) {
    throw new Error("ContinuousSubscriptionDefinition@2 source binding is inconsistent");
  }
}

function validateDefinitionBase(definition: ContinuousSubscriptionDefinition): void {
  if (!Number.isInteger(definition.revision) || definition.revision < 1) {
    throw new Error("continuous subscription revision must be positive");
  }
  text(definition.title, "title", 120);
  text(definition.probe.plugin.path, "plugin path", 4_096);
  text(definition.probe.plugin.id, "plugin id", 256);
  if (!Number.isInteger(definition.intervalMilliseconds) ||
    definition.intervalMilliseconds < 100 || definition.intervalMilliseconds > 86_400_000) {
    throw new Error("intervalMilliseconds must be between 100 and 86400000");
  }
  if (definition.externalRefBinding !== undefined) {
    parseExternalRefTriggerBinding(definition.externalRefBinding);
  }
}

function nextPoll(subscription: ContinuousSubscription, at: string): string {
  return new Date(Date.parse(at) + subscription.definition.intervalMilliseconds).toISOString();
}

function boundedJson(value: unknown, field: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 65_536) {
    throw new Error(`${field} exceeds 65536 bytes or is not JSON-serializable`);
  }
  return encoded;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return value;
}

function iso(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("timestamp must be RFC 3339");
  return new Date(milliseconds).toISOString();
}
