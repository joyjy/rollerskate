import type { DatabaseSync } from "node:sqlite";

import type { DeliveryRow } from "../../../infrastructure/sqlite/runtime-mappers.js";
import { withImmediateTransaction } from "../../../infrastructure/sqlite/transaction.js";

import {
  requireRuntimeId,
  runtimeId,
  type RuntimeDelivery,
  type RuntimeDestination
} from "../model.js";
import {
  annealedRetryAt,
  bounded,
  iso,
  requireText,
  validateAddress
} from "./codec.js";
import { RuntimeStoreQuery } from "./query.js";

export class RuntimeDeliveryStore {
  readonly #database: DatabaseSync;
  readonly #destinationCache: Map<string, RuntimeDestination>;
  readonly #query: RuntimeStoreQuery;

  public constructor(
    database: DatabaseSync,
    destinationCache: Map<string, RuntimeDestination>,
    query: RuntimeStoreQuery
  ) {
    this.#database = database;
    this.#destinationCache = destinationCache;
    this.#query = query;
  }

  public putDestination(input: {
    readonly destinationId?: string;
    readonly kind: RuntimeDestination["kind"];
    readonly address: Readonly<Record<string, string>>;
    readonly at?: string;
  }): RuntimeDestination {
    const destinationId = input.destinationId ?? runtimeId("dst");
    requireRuntimeId(destinationId, "dst", "destinationId");
    validateAddress(input.address);
    const timestamp = iso(input.at ?? new Date().toISOString());
    const existing = this.#query.destination(destinationId);
    const destination: RuntimeDestination = {
      destinationId,
      kind: input.kind,
      address: { ...input.address },
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.#destinationCache.set(destinationId, destination);
    return destination;
  }

  public claimDue(limit = 100, now = new Date().toISOString()): RuntimeDelivery[] {
    const timestamp = iso(now);
    return withImmediateTransaction(this.#database, () => {
      const rows = this.#database.prepare(`
        SELECT delivery_id FROM deliveries
        WHERE status IN ('pending', 'retry_wait')
          AND attempt_count < max_attempts
          AND julianday(next_attempt_at) <= julianday(?)
        ORDER BY next_attempt_at, created_at, delivery_id LIMIT ?
      `).all(timestamp, bounded(limit, 1, 500, "limit")) as unknown as Array<{
        delivery_id: string;
      }>;
      const claimed: RuntimeDelivery[] = [];
      for (const row of rows) {
        const changed = this.#database.prepare(`
          UPDATE deliveries SET status = 'delivering', attempt_count = attempt_count + 1,
            updated_at = ? WHERE delivery_id = ? AND status IN ('pending', 'retry_wait')
        `).run(timestamp, row.delivery_id);
        if (changed.changes === 1) claimed.push(this.#requireDelivery(row.delivery_id));
      }
      return claimed;
    });
  }

  public enqueueHostInTransaction(input: {
    readonly originId: string;
    readonly destinationId: string;
    readonly kind: RuntimeDestination["kind"];
    readonly address: Readonly<Record<string, string>>;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly maxAttempts?: number;
    readonly at?: string;
  }): RuntimeDelivery {
    const originId = requireText(input.originId, "originId");
    if (originId.length > 1_024) throw new Error("originId must be at most 1024 characters");
    requireRuntimeId(input.destinationId, "dst", "destinationId");
    validateAddress(input.address);
    const payloadJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadJson, "utf8") > 65_536) {
      throw new Error("Delivery payload exceeds 65536 bytes");
    }
    const timestamp = iso(input.at ?? new Date().toISOString());
    const existing = this.#query.destination(input.destinationId);
    if (existing !== undefined && (existing.kind !== input.kind ||
      canonicalJson(existing.address) !== canonicalJson(input.address))) {
      throw new Error(`Destination conflicts with canonical snapshot: ${input.destinationId}`);
    }
    if (existing === undefined) {
      this.putDestination({
        destinationId: input.destinationId,
        kind: input.kind,
        address: input.address,
        at: timestamp
      });
    }
    this.#database.prepare(`
      INSERT INTO deliveries (
        delivery_id, result_event_id, origin_kind, origin_id, destination_id,
        destination_kind, destination_address_json, payload_json, status,
        attempt_count, max_attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, NULL, 'host', ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
      ON CONFLICT(origin_kind, origin_id, destination_id) DO NOTHING
    `).run(
      runtimeId("del"),
      originId,
      input.destinationId,
      input.kind,
      JSON.stringify(input.address),
      payloadJson,
      bounded(input.maxAttempts ?? (input.kind === "macos-notification" ? 1 : 5),
        1, 30, "maxAttempts"),
      timestamp,
      timestamp,
      timestamp
    );
    const row = this.#database.prepare(`
      SELECT * FROM deliveries
      WHERE origin_kind = 'host' AND origin_id = ? AND destination_id = ?
    `).get(originId, input.destinationId) as DeliveryRow | undefined;
    if (row === undefined) throw new Error("Host Delivery was not persisted");
    return this.#requireDelivery(row.delivery_id);
  }

  public succeeded(
    deliveryId: string,
    receipt: string,
    at = new Date().toISOString()
  ): RuntimeDelivery {
    const timestamp = iso(at);
    const changed = this.#database.prepare(`
      UPDATE deliveries SET status = 'delivered', receipt = ?, last_error = NULL,
        updated_at = ? WHERE delivery_id = ? AND status = 'delivering'
    `).run(requireText(receipt, "receipt"), timestamp, deliveryId);
    if (changed.changes !== 1) throw new Error(`delivery is not delivering: ${deliveryId}`);
    return this.#requireDelivery(deliveryId);
  }

  public retryFailed(
    deliveryId: string,
    at = new Date().toISOString()
  ): RuntimeDelivery {
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => {
      const delivery = this.#requireDelivery(deliveryId);
      if (delivery.status !== "failed") return delivery;
      if (delivery.attemptCount >= 30) {
        throw new Error(`delivery retry limit reached: ${deliveryId}`);
      }
      const changed = this.#database.prepare(`
        UPDATE deliveries SET status = 'retry_wait', max_attempts = attempt_count + 1,
          next_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE delivery_id = ? AND status = 'failed'
      `).run(timestamp, timestamp, deliveryId);
      if (changed.changes !== 1) {
        throw new Error(`delivery is not failed: ${deliveryId}`);
      }
      return this.#requireDelivery(deliveryId);
    });
  }

  public failed(
    deliveryId: string,
    error: string,
    at = new Date().toISOString(),
    retryBaseMilliseconds = 1_000
  ): RuntimeDelivery {
    const timestamp = iso(at);
    const delivery = this.#requireDelivery(deliveryId);
    if (delivery.status !== "delivering") throw new Error(`delivery is not delivering: ${deliveryId}`);
    const exhausted = delivery.attemptCount >= delivery.maxAttempts;
    const nextAttemptAt = exhausted
      ? timestamp
      : annealedRetryAt(timestamp, delivery.attemptCount, retryBaseMilliseconds);
    this.#database.prepare(`
      UPDATE deliveries SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE delivery_id = ?
    `).run(
      exhausted ? "failed" : "retry_wait",
      nextAttemptAt,
      requireText(error, "error").slice(0, 4_096),
      timestamp,
      deliveryId
    );
    return this.#requireDelivery(deliveryId);
  }

  #requireDelivery(deliveryId: string): RuntimeDelivery {
    const delivery = this.#query.delivery(deliveryId);
    if (delivery === undefined) throw new Error(`Delivery not found: ${deliveryId}`);
    return delivery;
  }
}

function canonicalJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  ));
}
