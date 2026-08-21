import type { DatabaseSync } from "node:sqlite";

import {
  newEventId,
  requireEventId,
  type AgentInputEvent,
  type AgentResultEvent,
  type CreateEvent
} from "../../event/model.js";
import {
  requireRuntimeId,
  runtimeId,
  runtimeRoute,
  type RuntimeExecution
} from "../model.js";
import { bounded, iso, validateCreateEvent } from "./codec.js";
import { RuntimeStoreQuery } from "./query.js";
import type { AppendRuntimeEventReceipt } from "./types.js";

export class RuntimeEventStore {
  readonly #database: DatabaseSync;
  readonly #query: RuntimeStoreQuery;

  public constructor(database: DatabaseSync, query: RuntimeStoreQuery) {
    this.#database = database;
    this.#query = query;
  }

  public appendInTransaction(input: CreateEvent): AppendRuntimeEventReceipt {
    validateCreateEvent(input);
    const createdAt = iso(input.createdAt ?? new Date().toISOString());
    const maxAttempts = bounded(input.maxAttempts ?? 3, 1, 20, "maxAttempts");
    const eventId = input.eventId === undefined ? newEventId() : requireEventId(input.eventId);
    const executionId = runtimeId("exe");
    const route = runtimeRoute(input.type);
    const destinations = [...new Set(input.destinationIds ?? [])];
    if (destinations.length > 32) {
      throw new Error("destinationIds must contain at most 32 entries");
    }
    for (const destinationId of destinations) {
      requireRuntimeId(destinationId, "dst", "destinationId");
    }
    const destinationSnapshots = destinations.map((destinationId) => {
      const destination = this.#query.destination(destinationId);
      if (destination === undefined) throw new Error(`Destination not found: ${destinationId}`);
      return destination;
    });
    if (input.sessionId !== undefined) requireRuntimeId(input.sessionId, "ses", "sessionId");
    const rootEventId = input.parent?.rootEventId ?? eventId;
    const parentEventId = input.parent?.eventId;
    const hop = input.parent === undefined ? 0 : input.parent.hop + 1;
    if (parentEventId !== undefined) {
      requireRuntimeId(parentEventId, "evt", "parent.eventId");
      requireRuntimeId(rootEventId, "evt", "parent.rootEventId");
    }
    if (input.source.externalId !== undefined) {
      const existing = this.#database.prepare(`
        SELECT event_id FROM events WHERE source_kind = ? AND source_external_id = ?
      `).get(input.source.kind, input.source.externalId) as { event_id: string } | undefined;
      if (existing !== undefined) return this.#receipt(existing.event_id, "duplicate");
    }
    const payload = input.type === "subscription.fire"
      ? {
          schemaVersion: "SubscriptionFirePayload@1",
          observation: input.observation,
          ...(input.subscriptionInvocation === undefined
            ? {}
            : { invocation: input.subscriptionInvocation })
        }
      : input.runContext;
    this.#database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.type,
      input.source.kind,
      input.source.externalId ?? null,
      input.agentId,
      input.prompt,
      payload === undefined ? null : JSON.stringify(payload),
      input.sessionId ?? null,
      JSON.stringify(destinations),
      JSON.stringify(destinationSnapshots),
      rootEventId,
      parentEventId ?? null,
      hop,
      createdAt
    );
    this.#database.prepare(`
      INSERT INTO executions (
        execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)
    `).run(executionId, eventId, route.handler, maxAttempts, createdAt, createdAt, createdAt);
    return this.#receipt(eventId, "accepted");
  }

  public createResult(input: {
    readonly execution: RuntimeExecution;
    readonly event: AgentInputEvent;
    readonly outcome: AgentResultEvent["outcome"];
    readonly sessionId?: string;
    readonly output?: string;
    readonly error?: string;
    readonly at: string;
  }): AgentResultEvent {
    if (input.execution.handler !== "agent") {
      throw new Error(`Only AgentHandler can create agent.result: ${input.execution.executionId}`);
    }
    const eventId = newEventId();
    const resultExecutionId = runtimeId("exe");
    this.#database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        destination_snapshots_json,
        root_event_id, parent_event_id, causal_hop, created_at
      ) VALUES (?, 'agent.result', 'handler', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.execution.executionId,
      input.event.agentId,
      input.outcome,
      input.output ?? null,
      input.error ?? null,
      null,
      input.sessionId ?? null,
      JSON.stringify(input.event.destinationIds),
      JSON.stringify(this.#query.destinationSnapshots(input.event.eventId)),
      input.event.causality.rootEventId,
      input.event.eventId,
      input.event.causality.hop + 1,
      input.at
    );
    this.#database.prepare(`
      INSERT INTO executions (
        execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'result', 'queued', 0, 3, ?, ?, ?)
    `).run(resultExecutionId, eventId, input.at, input.at, input.at);
    const event = this.#query.event(eventId);
    if (event?.type !== "agent.result") throw new Error(`Event is not agent.result: ${eventId}`);
    return event;
  }

  #receipt(
    eventId: string,
    status: AppendRuntimeEventReceipt["status"]
  ): AppendRuntimeEventReceipt {
    const event = this.#query.event(eventId);
    if (event === undefined) throw new Error(`Event not found: ${eventId}`);
    const execution = this.#query.executionForEvent(eventId);
    if (execution === undefined) throw new Error(`Event has no Execution: ${eventId}`);
    return { event, execution, status };
  }
}
