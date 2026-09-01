import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { CreateEvent } from "../../core/event/model.js";
import { localId } from "../../core/id.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { openInitializedRuntimeDatabase } from "../sqlite/database.js";
import { migrateLocalDatabase } from "../sqlite/schema/index.js";
import { withImmediateTransaction } from "../sqlite/transaction.js";
import { reconcileInterruptedCallbacks } from "./recovery.js";
import {
  boundedProactiveCallbackJson,
  mapPersistedProactiveCallbackDefinition,
  mapProactiveCallbackOccurrence,
  validateProactiveCallback,
  type ProactiveCallbackDefinition,
  type ProactiveCallbackOccurrence,
  type ProactiveCallbackOccurrenceRow,
  type ProactiveCallbackOwner
} from "../../modules/callback/proactive-model.js";

interface DefinitionRow {
  readonly definition_id: string;
  readonly callback_id: string;
  readonly owner_kind: string;
  readonly owner_id: string;
  readonly owner_revision: number;
  readonly ordinal: number;
  readonly kind: string;
  readonly definition_schema: string;
  readonly definition_json: string;
  readonly grant_json: string;
  readonly created_at: string;
}

export interface ProactiveCallbackOccurrenceRef {
  readonly ownerKind: ProactiveCallbackOwner["kind"];
  readonly ownerId: string;
  readonly triggerOccurrenceKey: string;
}

export interface ProactiveAgentCompletion {
  readonly status: "succeeded" | "blocked" | "failed";
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export type ProactiveAgentCompletionInterpreter = (
  callback: ProactiveCallbackOccurrence,
  output: string | undefined
) => ProactiveAgentCompletion;

export interface ReconcileProactiveCallbacksOptions {
  readonly limit?: number;
  readonly ownerKinds?: readonly ProactiveCallbackOwner["kind"][];
  readonly interpretAgentCompletion?: ProactiveAgentCompletionInterpreter;
}

export class CallbackStore {
  readonly #database: DatabaseSync;
  readonly #runtime: RuntimeStore;
  readonly #ownsDatabase: boolean;

  public constructor(
    database: string | DatabaseSync,
    options: { readonly migrate?: boolean } = {}
  ) {
    this.#database = typeof database === "string"
      ? openInitializedRuntimeDatabase(database, migrateLocalDatabase)
      : database;
    this.#ownsDatabase = typeof database === "string";
    this.#runtime = new RuntimeStore(this.#database, options.migrate === undefined
      ? {}
      : { migrate: options.migrate });
  }

  public registerDefinitions(
    ownerInput: ProactiveCallbackOwner,
    definitionsInput: readonly ProactiveCallbackDefinition[],
    at = new Date().toISOString()
  ): void {
    withImmediateTransaction(this.#database, () => {
      this.registerDefinitionsInTransaction(ownerInput, definitionsInput, at);
    });
  }

  public registerDefinitionsInTransaction(
    ownerInput: ProactiveCallbackOwner,
    definitionsInput: readonly ProactiveCallbackDefinition[],
    at = new Date().toISOString()
  ): void {
    const owner = validOwner(ownerInput);
    if (definitionsInput.length > 64) throw new Error("callback count exceeds 64");
    const definitions = definitionsInput.map(validateProactiveCallback);
    if (new Set(definitions.map(({ callbackId }) => callbackId)).size !== definitions.length) {
      throw new Error("callbackId must be unique within an owner revision");
    }
    const timestamp = iso(at);
    {
      for (const [ordinal, callback] of definitions.entries()) {
        const definitionId = stableDefinitionId(owner, callback.callbackId);
        const definitionJson = boundedProactiveCallbackJson(
          callback.definition,
          "callback definition"
        );
        const grantJson = boundedProactiveCallbackJson(callback.grant, "callback grant");
        this.#database.prepare(`
          INSERT INTO proactive_callback_definitions (
            definition_id, callback_id, owner_kind, owner_id, owner_revision, ordinal,
            kind, definition_schema, definition_json, grant_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ProactiveCallbackDefinition@1', ?, ?, ?)
          ON CONFLICT(definition_id) DO NOTHING
        `).run(
          definitionId,
          callback.callbackId,
          owner.kind,
          owner.id,
          owner.revision,
          ordinal,
          callback.kind,
          definitionJson,
          grantJson,
          timestamp
        );
        const stored = this.#definition(definitionId);
        if (stored.callback_id !== callback.callbackId || stored.owner_kind !== owner.kind ||
          stored.owner_id !== owner.id || stored.owner_revision !== owner.revision ||
          stored.ordinal !== ordinal || stored.kind !== callback.kind ||
          stored.definition_json !== definitionJson || stored.grant_json !== grantJson) {
          throw new Error(`callback definition conflicts with immutable revision: ${callback.callbackId}`);
        }
      }
      const count = (this.#database.prepare(`
        SELECT COUNT(*) AS count FROM proactive_callback_definitions
        WHERE owner_kind = ? AND owner_id = ? AND owner_revision = ?
      `).get(owner.kind, owner.id, owner.revision) as { count: number }).count;
      if (count !== definitions.length) {
        throw new Error("callback definition count conflicts with immutable revision");
      }
    }
  }

  public materialize(
    ownerInput: ProactiveCallbackOwner,
    triggerOccurrenceKeyInput: string,
    at = new Date().toISOString()
  ): ProactiveCallbackOccurrence[] {
    return withImmediateTransaction(this.#database, () =>
      this.materializeInTransaction(ownerInput, triggerOccurrenceKeyInput, at));
  }

  public materializeInTransaction(
    ownerInput: ProactiveCallbackOwner,
    triggerOccurrenceKeyInput: string,
    at = new Date().toISOString()
  ): ProactiveCallbackOccurrence[] {
    const owner = validOwner(ownerInput);
    const triggerOccurrenceKey = boundedText(
      triggerOccurrenceKeyInput,
      "trigger occurrence key",
      1_024
    );
    const timestamp = iso(at);
    {
      const definitions = this.#definitions(owner);
      for (const definition of definitions) {
        this.#database.prepare(`
          INSERT INTO proactive_callback_occurrences (
            occurrence_id, owner_kind, owner_id, owner_revision, trigger_occurrence_key,
            definition_id, callback_id, ordinal, kind, definition_schema, definition_json,
            grant_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          ON CONFLICT(owner_kind, owner_id, trigger_occurrence_key, ordinal) DO NOTHING
        `).run(
          localId("pcb"),
          owner.kind,
          owner.id,
          owner.revision,
          triggerOccurrenceKey,
          definition.definition_id,
          definition.callback_id,
          definition.ordinal,
          definition.kind,
          definition.definition_schema,
          definition.definition_json,
          definition.grant_json,
          timestamp,
          timestamp
        );
      }
      const occurrences = this.#list(owner.kind, owner.id, triggerOccurrenceKey);
      if (occurrences.length !== definitions.length ||
        occurrences.some((occurrence) => occurrence.owner.revision !== owner.revision)) {
        throw new Error("callback occurrence conflicts with immutable trigger occurrence");
      }
      return occurrences;
    }
  }

  public list(ref: ProactiveCallbackOccurrenceRef): ProactiveCallbackOccurrence[] {
    return this.#list(ref.ownerKind, ref.ownerId, ref.triggerOccurrenceKey);
  }

  public definitions(ownerInput: ProactiveCallbackOwner): ProactiveCallbackDefinition[] {
    const owner = validOwner(ownerInput);
    return this.#definitions(owner).map((row) => mapPersistedProactiveCallbackDefinition({
      callbackId: row.callback_id,
      kind: row.kind as ProactiveCallbackDefinition["kind"],
      definition: JSON.parse(row.definition_json) as Readonly<Record<string, unknown>>,
      grant: JSON.parse(row.grant_json) as Readonly<Record<string, unknown>>
    }));
  }

  public definitionsForOwners(
    ownerInputs: readonly ProactiveCallbackOwner[]
  ): ReadonlyMap<string, readonly ProactiveCallbackDefinition[]> {
    if (ownerInputs.length > 100) throw new Error("callback owners exceed 100 items");
    const result = new Map<string, ProactiveCallbackDefinition[]>();
    const owners = ownerInputs.map(validOwner);
    for (const owner of owners) result.set(ownerKey(owner), []);
    if (owners.length === 0) return result;
    const tuples = owners.map(() => "(?, ?, ?)").join(", ");
    const rows = this.#database.prepare(`
      SELECT * FROM proactive_callback_definitions
      WHERE (owner_kind, owner_id, owner_revision) IN (${tuples})
      ORDER BY owner_kind, owner_id, owner_revision, ordinal
      LIMIT 6400
    `).all(...owners.flatMap((owner) => [owner.kind, owner.id, owner.revision])) as unknown as
      DefinitionRow[];
    for (const row of rows) {
      const owner = {
        kind: row.owner_kind as ProactiveCallbackOwner["kind"],
        id: row.owner_id,
        revision: row.owner_revision
      };
      result.get(ownerKey(owner))!.push(mapPersistedProactiveCallbackDefinition({
        callbackId: row.callback_id,
        kind: row.kind as ProactiveCallbackDefinition["kind"],
        definition: JSON.parse(row.definition_json) as Readonly<Record<string, unknown>>,
        grant: JSON.parse(row.grant_json) as Readonly<Record<string, unknown>>
      }));
    }
    return result;
  }

  public ready(limit = 20): ProactiveCallbackOccurrenceRef[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer between 1 and 100");
    }
    return (this.#database.prepare(`
      SELECT owner_kind, owner_id, trigger_occurrence_key, MIN(created_at) AS created_at
      FROM proactive_callback_occurrences AS candidate
      WHERE status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM proactive_callback_occurrences AS active
          WHERE active.owner_kind = candidate.owner_kind
            AND active.owner_id = candidate.owner_id
            AND active.trigger_occurrence_key = candidate.trigger_occurrence_key
            AND active.status = 'started'
        )
      GROUP BY owner_kind, owner_id, trigger_occurrence_key
      ORDER BY created_at, owner_kind, owner_id, trigger_occurrence_key
      LIMIT ?
    `).all(limit) as unknown as Array<{
      owner_kind: ProactiveCallbackOwner["kind"];
      owner_id: string;
      trigger_occurrence_key: string;
    }>).map((row) => ({
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      triggerOccurrenceKey: row.trigger_occurrence_key
    }));
  }

  public beginNext(
    ref: ProactiveCallbackOccurrenceRef,
    at = new Date().toISOString()
  ): ProactiveCallbackOccurrence | undefined {
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => {
      const row = this.#database.prepare(`
        SELECT * FROM proactive_callback_occurrences
        WHERE owner_kind = ? AND owner_id = ? AND trigger_occurrence_key = ?
          AND status = 'pending'
        ORDER BY ordinal LIMIT 1
      `).get(ref.ownerKind, ref.ownerId, ref.triggerOccurrenceKey) as
        ProactiveCallbackOccurrenceRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const changed = this.#database.prepare(`
        UPDATE proactive_callback_occurrences
        SET status = 'started', started_at = ?, updated_at = ?
        WHERE occurrence_id = ? AND status = 'pending'
      `).run(timestamp, timestamp, row.occurrence_id).changes;
      if (changed !== 1) throw new Error(`callback occurrence is not pending: ${row.occurrence_id}`);
      const result = this.#require(row.occurrence_id);
      return result;
    });
  }

  public admitAgentEvent(
    occurrenceId: string,
    input: CreateEvent,
    at = new Date().toISOString()
  ): ProactiveCallbackOccurrence {
    if (input.type !== "agent.request" && input.type !== "subscription.fire") {
      throw new Error("Agent callback must admit an Agent-handled Event");
    }
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => {
      const occurrence = this.#require(occurrenceId);
      if (occurrence.status !== "started" || occurrence.eventId !== undefined) {
        throw new Error(`callback occurrence cannot admit Agent Event: ${occurrenceId}`);
      }
      const receipt = this.#runtime.appendEventInTransaction(input);
      const changed = this.#database.prepare(`
        UPDATE proactive_callback_occurrences SET event_id = ?, updated_at = ?
        WHERE occurrence_id = ? AND status = 'started' AND event_id IS NULL
      `).run(receipt.event.eventId, timestamp, occurrenceId).changes;
      if (changed !== 1) throw new Error(`callback occurrence cannot attach Event: ${occurrenceId}`);
      const admitted = this.#require(occurrenceId);
      return admitted;
    });
  }

  public admitDelivery(
    occurrenceId: string,
    input: {
      readonly destinationId: string;
      readonly kind: "matrix" | "macos-notification";
      readonly address: Readonly<Record<string, string>>;
      readonly payload: Readonly<Record<string, unknown>>;
    },
    at = new Date().toISOString()
  ): ProactiveCallbackOccurrence {
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => {
      const occurrence = this.#require(occurrenceId);
      if (occurrence.status !== "started" || occurrence.kind !== "destination.deliver") {
        throw new Error(`callback occurrence cannot admit Delivery: ${occurrenceId}`);
      }
      const delivery = this.#runtime.enqueueHostDeliveryInTransaction({
        originId: `proactive-callback:${occurrenceId}`,
        destinationId: input.destinationId,
        kind: input.kind,
        address: input.address,
        payload: input.payload,
        at: timestamp
      });
      const changed = this.#database.prepare(`
        UPDATE proactive_callback_occurrences SET receipt_json = ?, updated_at = ?
        WHERE occurrence_id = ? AND status = 'started'
      `).run(
        boundedProactiveCallbackJson({
          schemaVersion: "ProactiveCallbackReceipt@1",
          outcome: "admitted",
          deliveryId: delivery.deliveryId
        }, "callback receipt"),
        timestamp,
        occurrenceId
      ).changes;
      if (changed !== 1) throw new Error(`callback occurrence cannot attach Delivery: ${occurrenceId}`);
      const admitted = this.#require(occurrenceId);
      return admitted;
    });
  }

  public succeed(occurrenceId: string, receipt: unknown, at?: string): ProactiveCallbackOccurrence {
    return this.#finish(occurrenceId, "succeeded", receipt, null, at);
  }

  public fail(
    occurrenceId: string,
    error: string,
    receipt: unknown,
    at?: string
  ): ProactiveCallbackOccurrence {
    return this.#finish(occurrenceId, "failed", receipt, nonEmpty(error, "callback error"), at);
  }

  public block(
    occurrenceId: string,
    reason: string,
    receipt: unknown,
    at?: string
  ): ProactiveCallbackOccurrence {
    return this.#finish(
      occurrenceId,
      "blocked",
      receipt,
      nonEmpty(reason, "callback blocked reason"),
      at
    );
  }

  public resolveUnknownGroupInTransaction(
    ref: ProactiveCallbackOccurrenceRef,
    outcome: "succeeded" | "failed",
    at = new Date().toISOString()
  ): number {
    const timestamp = iso(at);
    const occurrences = this.#list(ref.ownerKind, ref.ownerId, ref.triggerOccurrenceKey);
    const activeDelivery = this.#database.prepare(`
      SELECT 1
      FROM proactive_callback_occurrences AS occurrence
      JOIN deliveries AS delivery
        ON delivery.origin_kind = 'host'
        AND delivery.origin_id = 'proactive-callback:' || occurrence.occurrence_id
      WHERE occurrence.owner_kind = ? AND occurrence.owner_id = ?
        AND occurrence.trigger_occurrence_key = ?
        AND delivery.status IN ('pending', 'delivering', 'retry_wait')
      LIMIT 1
    `).get(ref.ownerKind, ref.ownerId, ref.triggerOccurrenceKey);
    if (activeDelivery !== undefined) {
      throw new Error("Scheduled callback Delivery is still active");
    }
    let changed = 0;
    for (const occurrence of occurrences) {
      if (occurrence.status !== "unknown" && occurrence.status !== "pending" &&
        occurrence.status !== "started") continue;
      const receipt = boundedProactiveCallbackJson({
        schemaVersion: "ProactiveCallbackReceipt@1",
        outcome,
        resolution: "manual",
        priorStatus: occurrence.status
      }, "callback receipt");
      changed += Number(this.#database.prepare(`
        UPDATE proactive_callback_occurrences
        SET status = ?, receipt_json = ?, last_error = ?, completed_at = ?, updated_at = ?
        WHERE occurrence_id = ? AND status = ?
      `).run(
        outcome,
        receipt,
        outcome === "failed" ? "manual_resolved_failed" : null,
        timestamp,
        timestamp,
        occurrence.occurrenceId,
        occurrence.status
      ).changes);
    }
    return changed;
  }

  public reconcileCompleted(
    at = new Date().toISOString(),
    options: ReconcileProactiveCallbacksOptions = {}
  ): number {
    const timestamp = iso(at);
    const limit = options.limit ?? 100;
    boundedLimit(limit);
    const ownerKinds = options.ownerKinds === undefined
      ? []
      : validOwnerKinds(options.ownerKinds);
    const ownerFilter = ownerKinds.length === 0
      ? ""
      : ` AND occurrence.owner_kind IN (${ownerKinds.map(() => "?").join(",")})`;
    const rows = this.#database.prepare(`
      SELECT occurrence.occurrence_id, occurrence.event_id,
        execution.execution_id, execution.status, execution.last_error
      FROM proactive_callback_occurrences AS occurrence
      JOIN executions AS execution ON execution.event_id = occurrence.event_id
      WHERE occurrence.status = 'started' AND execution.status IN ('succeeded', 'failed')
        ${ownerFilter}
      ORDER BY occurrence.created_at, occurrence.ordinal
      LIMIT ?
    `).all(...ownerKinds, limit) as unknown as Array<{
      occurrence_id: string;
      event_id: string;
      execution_id: string;
      status: "succeeded" | "failed";
      last_error: string | null;
    }>;
    let changed = 0;
    for (const row of rows) {
      if (row.status === "failed" && row.last_error === "runtime_interrupted") continue;
      const receipt = {
        schemaVersion: "ProactiveCallbackReceipt@1",
        outcome: row.status,
        eventId: row.event_id,
        executionId: row.execution_id
      };
      if (row.status === "succeeded" && options.interpretAgentCompletion !== undefined) {
        const callback = this.#require(row.occurrence_id);
        const output = callback.eventId === undefined
          ? undefined
          : this.#runtime.audit(callback.eventId)?.resultEvent?.output;
        const completion = options.interpretAgentCompletion(callback, output);
        const semanticReceipt = { ...receipt, ...(completion.receipt ?? {}) };
        if (completion.status === "succeeded") {
          this.succeed(row.occurrence_id, semanticReceipt, timestamp);
        } else if (completion.status === "blocked") {
          this.block(
            row.occurrence_id,
            completion.error ?? "callback_blocked",
            semanticReceipt,
            timestamp
          );
        } else {
          this.fail(
            row.occurrence_id,
            completion.error ?? "callback_failed",
            semanticReceipt,
            timestamp
          );
        }
      } else if (row.status === "succeeded") {
        this.succeed(row.occurrence_id, receipt, timestamp);
      } else {
        this.fail(row.occurrence_id, row.last_error ?? "callback_failed", receipt, timestamp);
      }
      changed += 1;
    }
    const deliveries = this.#database.prepare(`
      SELECT occurrence.occurrence_id, delivery.delivery_id, delivery.status,
        delivery.receipt, delivery.last_error
      FROM proactive_callback_occurrences AS occurrence
      JOIN deliveries AS delivery
        ON delivery.origin_kind = 'host'
        AND delivery.origin_id = 'proactive-callback:' || occurrence.occurrence_id
      WHERE occurrence.status = 'started' AND delivery.status IN ('delivered', 'failed')
        ${ownerFilter}
      ORDER BY occurrence.created_at, occurrence.ordinal
      LIMIT ?
    `).all(...ownerKinds, limit) as unknown as Array<{
      occurrence_id: string;
      delivery_id: string;
      status: "delivered" | "failed";
      receipt: string | null;
      last_error: string | null;
    }>;
    for (const delivery of deliveries) {
      const receipt = {
        schemaVersion: "ProactiveCallbackReceipt@1",
        outcome: delivery.status === "delivered" ? "succeeded" : "failed",
        deliveryId: delivery.delivery_id,
        ...(delivery.receipt === null ? {} : { adapterReceipt: delivery.receipt })
      };
      if (delivery.status === "delivered") {
        this.succeed(delivery.occurrence_id, receipt, timestamp);
      } else {
        this.fail(
          delivery.occurrence_id,
          delivery.last_error ?? "delivery_failed",
          receipt,
          timestamp
        );
      }
      changed += 1;
    }
    return changed;
  }

  public reconcileInterrupted(at = new Date().toISOString(), limit = 100): number {
    const timestamp = iso(at);
    boundedLimit(limit);
    return withImmediateTransaction(this.#database, () => {
      const groups = this.#database.prepare(`
        SELECT DISTINCT owner_kind, owner_id, trigger_occurrence_key
        FROM proactive_callback_occurrences AS occurrence
        WHERE status = 'started'
          AND NOT EXISTS (
            SELECT 1 FROM deliveries AS delivery
            WHERE delivery.origin_kind = 'host'
              AND delivery.origin_id = 'proactive-callback:' || occurrence.occurrence_id
          )
        ORDER BY owner_kind, owner_id, trigger_occurrence_key
        LIMIT ?
      `).all(limit) as unknown as Array<{
        owner_kind: string;
        owner_id: string;
        trigger_occurrence_key: string;
      }>;
      const changed = reconcileInterruptedCallbacks({
        runtime: this.#runtime,
        groups,
        reason: "runtime_interrupted",
        at: timestamp,
        eventIds: (group) => (this.#database.prepare(`
          SELECT event_id FROM proactive_callback_occurrences
          WHERE owner_kind = ? AND owner_id = ? AND trigger_occurrence_key = ?
            AND event_id IS NOT NULL AND status IN ('started', 'pending')
        `).all(
          group.owner_kind,
          group.owner_id,
          group.trigger_occurrence_key
        ) as unknown as Array<{ event_id: string }>).map(({ event_id }) => event_id),
        markUnknown: (group) => Number(this.#database.prepare(`
          UPDATE proactive_callback_occurrences
          SET status = 'unknown', completed_at = ?, updated_at = ?,
            last_error = 'runtime_interrupted'
          WHERE owner_kind = ? AND owner_id = ? AND trigger_occurrence_key = ?
            AND status IN ('started', 'pending')
        `).run(
          timestamp,
          timestamp,
          group.owner_kind,
          group.owner_id,
          group.trigger_occurrence_key
        ).changes)
      });
      return changed;
    });
  }

  public close(): void {
    if (this.#ownsDatabase) this.#database.close();
  }

  #finish(
    occurrenceId: string,
    status: "succeeded" | "blocked" | "failed",
    receipt: unknown,
    error: string | null,
    at = new Date().toISOString()
  ): ProactiveCallbackOccurrence {
    const timestamp = iso(at);
    const changed = this.#database.prepare(`
      UPDATE proactive_callback_occurrences
      SET status = ?, receipt_json = ?, last_error = ?, completed_at = ?, updated_at = ?
      WHERE occurrence_id = ? AND status = 'started'
    `).run(
      status,
      boundedProactiveCallbackJson(receipt, "callback receipt"),
      error === null ? null : error.slice(0, 4_096),
      timestamp,
      timestamp,
      occurrenceId
    ).changes;
    if (changed !== 1) throw new Error(`callback occurrence is not started: ${occurrenceId}`);
    return this.#require(occurrenceId);
  }

  #definitions(owner: ProactiveCallbackOwner): DefinitionRow[] {
    return this.#database.prepare(`
      SELECT * FROM proactive_callback_definitions
      WHERE owner_kind = ? AND owner_id = ? AND owner_revision = ?
      ORDER BY ordinal
    `).all(owner.kind, owner.id, owner.revision) as unknown as DefinitionRow[];
  }

  #definition(definitionId: string): DefinitionRow {
    const row = this.#database.prepare(`
      SELECT * FROM proactive_callback_definitions WHERE definition_id = ?
    `).get(definitionId) as DefinitionRow | undefined;
    if (row === undefined) throw new Error(`proactive callback definition not found: ${definitionId}`);
    return row;
  }

  #list(
    ownerKind: ProactiveCallbackOwner["kind"],
    ownerId: string,
    triggerOccurrenceKey: string
  ): ProactiveCallbackOccurrence[] {
    return (this.#database.prepare(`
      SELECT * FROM proactive_callback_occurrences
      WHERE owner_kind = ? AND owner_id = ? AND trigger_occurrence_key = ?
      ORDER BY ordinal
    `).all(ownerKind, ownerId, triggerOccurrenceKey) as unknown as
      ProactiveCallbackOccurrenceRow[]).map(mapProactiveCallbackOccurrence);
  }

  #require(occurrenceId: string): ProactiveCallbackOccurrence {
    const row = this.#database.prepare(`
      SELECT * FROM proactive_callback_occurrences WHERE occurrence_id = ?
    `).get(occurrenceId) as ProactiveCallbackOccurrenceRow | undefined;
    if (row === undefined) throw new Error(`proactive callback occurrence not found: ${occurrenceId}`);
    return mapProactiveCallbackOccurrence(row);
  }
}

function stableDefinitionId(owner: ProactiveCallbackOwner, callbackId: string): string {
  return `pcd_${createHash("sha256")
    .update(`${owner.kind}\0${owner.id}\0${owner.revision}\0${callbackId}`)
    .digest("hex")}`;
}

function validOwner(owner: ProactiveCallbackOwner): ProactiveCallbackOwner {
  if (owner.kind !== "schedule" && owner.kind !== "subscription" &&
    owner.kind !== "continuous_subscription") {
    throw new Error("callback owner kind is invalid");
  }
  boundedText(owner.id, "callback owner id", 512);
  if (!Number.isInteger(owner.revision) || owner.revision < 1) {
    throw new Error("callback owner revision must be a positive integer");
  }
  return owner;
}

function validOwnerKinds(
  ownerKinds: readonly ProactiveCallbackOwner["kind"][]
): ProactiveCallbackOwner["kind"][] {
  if (ownerKinds.length === 0) throw new Error("callback ownerKinds must not be empty");
  const unique = [...new Set(ownerKinds)];
  for (const kind of unique) {
    if (kind !== "schedule" && kind !== "subscription" &&
      kind !== "continuous_subscription") {
      throw new Error("callback owner kind is invalid");
    }
  }
  return unique;
}

function ownerKey(owner: ProactiveCallbackOwner): string {
  return `${owner.kind}\0${owner.id}\0${owner.revision}`;
}

function boundedLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function boundedText(value: string, field: string, maximum: number): string {
  const result = nonEmpty(value, field);
  if (result.length > maximum) throw new Error(`${field} must be at most ${maximum} characters`);
  return result;
}

function iso(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("timestamp must be RFC 3339");
  return new Date(milliseconds).toISOString();
}
