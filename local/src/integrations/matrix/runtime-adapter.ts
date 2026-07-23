import type { DatabaseSync } from "node:sqlite";

import type { RoomEventPage, RoomEventProjection, RoomHead } from "@rollerskate/protocol";

import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import type { RuntimeDestinationAdapter } from "../../core/runtime/handlers.js";
import type { RuntimeDestination } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";

export interface MatrixIngressPolicy {
  readonly wakeMode: "disabled" | "mention_only" | "proactive";
  readonly ownerMessageWake: "never" | "mention_only" | "normal";
}

export interface MatrixBinding {
  readonly bindingId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentMxid?: string;
  readonly roomId: string;
  readonly ownerHumanId: string;
  readonly policy: MatrixIngressPolicy;
}

export interface MatrixHistory {
  head(roomId: string): Promise<RoomHead>;
  events(input: {
    readonly roomId: string;
    readonly after?: string;
    readonly through: string;
    readonly limit: number;
  }): Promise<RoomEventPage>;
}

export interface MatrixPublisher {
  send(input: {
    readonly agentId: string;
    readonly roomId: string;
    readonly transactionId: string;
    readonly body: string;
    readonly causalChainId: string;
    readonly causalHop: number;
  }): Promise<{ readonly eventId: string }>;
}

export interface MatrixIngressCycleResult {
  readonly bindingId: string;
  readonly destinationId: string;
  readonly roomId: string;
  readonly readThrough: string;
  readonly scanned: number;
  readonly acceptedEventIds: readonly string[];
  readonly ignoredExternalIds: readonly string[];
}

interface BindingRow {
  binding_id: string;
  destination_id: string;
  room_id: string;
  agent_id: string;
  session_id: string | null;
  sync_through: string | null;
}

export class MatrixIngress {
  readonly #bindings = new Map<string, MatrixBinding>();
  readonly #database: DatabaseSync;
  readonly #history: MatrixHistory;
  readonly #pageSize: number;
  readonly #runtime: RuntimeStore;

  public constructor(options: {
    readonly databasePath: string;
    readonly history: MatrixHistory;
    readonly pageSize?: number;
  }) {
    this.#database = openRuntimeDatabase(options.databasePath);
    this.#runtime = new RuntimeStore(options.databasePath);
    this.#history = options.history;
    this.#pageSize = bounded(options.pageSize ?? 50, 1, 100, "pageSize");
    this.#migrate();
  }

  public register(binding: MatrixBinding, at = new Date().toISOString()): RuntimeDestination {
    validateBinding(binding);
    const timestamp = iso(at);
    const existing = this.#row(binding.bindingId);
    const destination = existing === undefined
      ? this.#runtime.putDestination({
          kind: "matrix",
          address: {
            bindingId: binding.bindingId,
            roomId: binding.roomId,
            agentId: binding.agentId
          },
          at: timestamp
        })
      : this.#runtime.putDestination({
          destinationId: existing.destination_id,
          kind: "matrix",
          address: {
            bindingId: binding.bindingId,
            roomId: binding.roomId,
            agentId: binding.agentId
          },
          at: timestamp
        });
    this.#database.prepare(`
      INSERT INTO matrix_bindings (
        binding_id, destination_id, room_id, agent_id, session_id, sync_through, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        destination_id = excluded.destination_id,
        room_id = excluded.room_id,
        agent_id = excluded.agent_id,
        updated_at = excluded.updated_at
    `).run(binding.bindingId, destination.destinationId, binding.roomId, binding.agentId, timestamp);
    this.#bindings.set(binding.bindingId, binding);
    return destination;
  }

  public bindingIds(): string[] {
    return [...this.#bindings.keys()].sort();
  }

  public async runCycle(
    bindingId: string,
    now = new Date().toISOString()
  ): Promise<MatrixIngressCycleResult> {
    const binding = this.#bindings.get(bindingId);
    if (binding === undefined) throw new Error(`Matrix binding not registered: ${bindingId}`);
    const state = this.#requireRow(bindingId);
    const snapshot = await this.#history.head(binding.roomId);
    if (snapshot.roomId !== binding.roomId) {
      throw new Error(`Room head response does not match Destination: ${binding.roomId}`);
    }
    let after = state.sync_through ?? undefined;
    let scanned = 0;
    const acceptedEventIds: string[] = [];
    const ignoredExternalIds: string[] = [];
    while (after !== snapshot.head) {
      const page = await this.#history.events({
        roomId: binding.roomId,
        ...(after === undefined ? {} : { after }),
        through: snapshot.head,
        limit: this.#pageSize
      });
      validatePage(binding.roomId, snapshot.head, after, page);
      for (const projection of page.events) {
        scanned += 1;
        if (!eligible(projection, binding)) {
          ignoredExternalIds.push(projection.event.eventId);
          continue;
        }
        const receipt = this.#runtime.appendEvent({
          type: "agent.request",
          source: { kind: "matrix", externalId: projection.event.eventId },
          agentId: binding.agentId,
          prompt: matrixPrompt(projection),
          ...(state.session_id === null ? {} : { sessionId: state.session_id }),
          destinationIds: [state.destination_id],
          createdAt: now
        });
        acceptedEventIds.push(receipt.event.eventId);
      }
      after = page.complete ? snapshot.head : page.nextCursor;
      if (after === undefined) throw new Error(`Room history pagination made no progress: ${binding.roomId}`);
      this.#database.prepare(`
        UPDATE matrix_bindings SET sync_through = ?, updated_at = ? WHERE binding_id = ?
      `).run(after, iso(now), bindingId);
    }
    return {
      bindingId,
      destinationId: state.destination_id,
      roomId: binding.roomId,
      readThrough: snapshot.head,
      scanned,
      acceptedEventIds,
      ignoredExternalIds
    };
  }

  public close(): void {
    try {
      this.#runtime.close();
    } finally {
      this.#database.close();
    }
  }

  #row(bindingId: string): BindingRow | undefined {
    return this.#database.prepare(`
      SELECT * FROM matrix_bindings WHERE binding_id = ?
    `).get(bindingId) as BindingRow | undefined;
  }

  #requireRow(bindingId: string): BindingRow {
    const row = this.#row(bindingId);
    if (row === undefined) throw new Error(`Matrix binding state not found: ${bindingId}`);
    return row;
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS matrix_bindings (
        binding_id TEXT PRIMARY KEY,
        destination_id TEXT NOT NULL UNIQUE REFERENCES destinations(destination_id),
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(session_id),
        sync_through TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }
}

export class MatrixDeliveryAdapter implements RuntimeDestinationAdapter {
  public readonly kind = "matrix" as const;
  readonly #database: DatabaseSync;
  readonly #publisher: MatrixPublisher;

  public constructor(options: {
    readonly databasePath: string;
    readonly publisher: MatrixPublisher;
  }) {
    this.#database = openRuntimeDatabase(options.databasePath);
    this.#publisher = options.publisher;
  }

  public async deliver(input: Parameters<RuntimeDestinationAdapter["deliver"]>[0]):
  Promise<{ readonly receipt: string }> {
    const address = input.destination.address;
    const roomId = address.roomId;
    const agentId = address.agentId;
    const bindingId = address.bindingId;
    if (roomId === undefined || agentId === undefined || bindingId === undefined) {
      throw new Error(`Matrix destination address is incomplete: ${input.destination.destinationId}`);
    }
    const body = input.resultEvent.outcome === "succeeded"
      ? input.resultEvent.output
      : input.resultEvent.error;
    if (body === undefined || body.trim() === "") {
      throw new Error(`Result Event has no Matrix delivery body: ${input.resultEvent.eventId}`);
    }
    const receipt = await this.#publisher.send({
      agentId,
      roomId,
      transactionId: input.delivery.deliveryId,
      body,
      causalChainId: input.requestEvent.causality.rootEventId,
      causalHop: input.resultEvent.causality.hop
    });
    if (input.resultEvent.sessionId !== undefined) {
      this.#database.prepare(`
        UPDATE matrix_bindings SET session_id = ?, updated_at = ?
        WHERE binding_id = ? AND destination_id = ?
      `).run(input.resultEvent.sessionId, new Date().toISOString(),
        bindingId, input.destination.destinationId);
    }
    return { receipt: receipt.eventId };
  }

  public close(): void {
    this.#database.close();
  }
}

function eligible(event: RoomEventProjection, binding: MatrixBinding): boolean {
  if (binding.policy.wakeMode === "disabled") return false;
  if (event.event.source.kind === "agent" && event.event.source.id === binding.agentId) return false;
  const owner = event.event.source.kind === "human" && event.event.source.id === binding.ownerHumanId;
  const mention = mentions(event, binding);
  if (owner && binding.policy.ownerMessageWake === "never") return false;
  if (owner && binding.policy.ownerMessageWake === "mention_only" && !mention) return false;
  return binding.policy.wakeMode === "proactive" || mention;
}

function mentions(event: RoomEventProjection, binding: MatrixBinding): boolean {
  const payload = event.event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const explicit = payload.mentionedAgentIds;
  if (Array.isArray(explicit) && explicit.includes(binding.agentId)) return true;
  const matrix = payload["m.mentions"];
  if (binding.agentMxid !== undefined && typeof matrix === "object" && matrix !== null &&
    !Array.isArray(matrix) && Array.isArray(matrix.user_ids) &&
    matrix.user_ids.includes(binding.agentMxid)) return true;
  return typeof payload.body === "string" &&
    (payload.body.includes(`@${binding.agentName}`) || payload.body.includes(binding.agentId));
}

function matrixPrompt(event: RoomEventProjection): string {
  return [
    "Handle this fixed-schema Matrix ingress event.",
    `Room: ${event.roomId}`,
    `External event: ${event.event.eventId}`,
    JSON.stringify(event.event.payload)
  ].join("\n");
}

function validateBinding(binding: MatrixBinding): void {
  for (const [field, value] of Object.entries({
    bindingId: binding.bindingId,
    agentId: binding.agentId,
    agentName: binding.agentName,
    roomId: binding.roomId,
    ownerHumanId: binding.ownerHumanId
  })) {
    if (value.trim() === "") throw new Error(`${field} must be non-empty`);
  }
}

function validatePage(
  roomId: string,
  through: string,
  after: string | undefined,
  page: RoomEventPage
): void {
  if (page.roomId !== roomId || page.through !== through ||
    page.events.some((event) => event.roomId !== roomId)) {
    throw new Error(`Room history response does not match Destination: ${roomId}`);
  }
  if (!page.complete && (page.nextCursor === undefined || page.nextCursor === after)) {
    throw new Error(`Room history pagination made no progress: ${roomId}`);
  }
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function iso(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error("timestamp must be ISO-8601");
  return new Date(timestamp).toISOString();
}
