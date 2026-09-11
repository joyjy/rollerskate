import type { DatabaseSync } from "node:sqlite";

import {
  mapChatPresence,
  mapDelivery,
  mapDestination,
  mapEvent,
  mapExecution,
  mapSession,
  type ChatPresenceRow,
  type DeliveryRow,
  type DestinationRow,
  type EventRow,
  type ExecutionRow,
  type SessionRow
} from "../../../infrastructure/sqlite/runtime-mappers.js";
import type { ChatPresence } from "../../chat/model.js";
import {
  requireEventId,
  type AgentResultEvent,
  type ChatActivationEvent,
  type ChatDispatchEvent,
  type ChatMessageEvent,
  type Event
} from "../../event/model.js";
import type { RuntimeDelivery, RuntimeDestination, RuntimeExecution, RuntimeSession } from "../model.js";
import {
  bounded,
  parseChatAttentionReceiptList,
  parseChatDecisionReceipt,
  parseDestinationSnapshots,
  requireText,
  type DestinationSnapshot
} from "./codec.js";
import type {
  ChatAttentionReceipt,
  ChatDecisionReceipt
} from "../../../infrastructure/sqlite/runtime-mappers.js";

export class RuntimeStoreQuery {
  readonly #database: DatabaseSync;
  readonly #schedulingEvents = new Map<string, Event>();
  readonly #destinationCache: Map<string, RuntimeDestination>;

  public constructor(
    database: DatabaseSync,
    destinationCache: Map<string, RuntimeDestination>
  ) {
    this.#database = database;
    this.#destinationCache = destinationCache;
  }

  public executionSchedulingSnapshot(at = new Date().toISOString()) {
    const timestamp = at;
    const rows = this.#database.prepare(`
      SELECT * FROM executions
      WHERE status = 'running' OR (status IN ('queued', 'retry_wait') AND
        (julianday(next_attempt_at) <= julianday(?) OR handler = 'result'))
      ORDER BY next_attempt_at, created_at, execution_id
    `).all(timestamp) as unknown as ExecutionRow[];
    const entries = rows.map(mapExecution);
    // Canonical Events are immutable. Cache only current scheduling inputs, with a hard bound.
    const required = new Set(entries.map(item => item.eventId));
    const load = (ids: string[]) => {
      if (ids.length === 0) return;
      for (const row of this.#database.prepare("SELECT * FROM events WHERE event_id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(ids)) as unknown as EventRow[]) events.set(row.event_id, mapEvent(row));
    };
    const events = new Map([...this.#schedulingEvents].filter(([id]) => required.has(id)));
    load([...required].filter(id => !events.has(id)));
    for (const event of events.values()) if (event.type === "agent.result" && event.causality.parentEventId !== undefined) {
      const id = event.causality.parentEventId;
      required.add(id);
      const cached = this.#schedulingEvents.get(id);
      if (cached !== undefined) events.set(id, cached);
    }
    load([...required].filter(id => !events.has(id)));
    this.#schedulingEvents.clear();
    for (const [id, event] of events) {
      if (this.#schedulingEvents.size >= 1_000) break;
      this.#schedulingEvents.set(id, event);
    }
    return {
      events,
      due: entries.filter(item => item.status !== "running" && Date.parse(item.nextAttemptAt) <= Date.parse(timestamp)),
      running: entries.filter(item => item.status === "running"),
      resultBarriers: entries.filter(item => item.handler === "result" && item.status !== "running")
    };
  }

  public nextFutureExecutionAt(at: string): string | undefined {
    const row = this.#database.prepare(`SELECT next_attempt_at FROM executions
      WHERE status IN ('queued', 'retry_wait') AND julianday(next_attempt_at) > julianday(?)
      ORDER BY next_attempt_at, execution_id LIMIT 1`).get(at) as { next_attempt_at: string } | undefined;
    return row?.next_attempt_at;
  }

  public event(eventId: string): Event | undefined {
    const row = this.#database.prepare("SELECT * FROM events WHERE event_id = ?")
      .get(eventId) as EventRow | undefined;
    return row === undefined ? undefined : mapEvent(row);
  }

  public events(limit = 100): Event[] {
    return (this.#database.prepare(`
      SELECT * FROM events ORDER BY created_at DESC, event_id DESC LIMIT ?
    `).all(bounded(limit, 1, 1_000, "limit")) as unknown as EventRow[]).map(mapEvent);
  }

  public eventsForRoot(rootEventId: string): Event[] {
    return (this.#database.prepare(`
      SELECT * FROM events
      WHERE root_event_id = ?
      ORDER BY created_at ASC, event_id ASC
    `).all(requireEventId(rootEventId, "rootEventId")) as unknown as EventRow[]).map(mapEvent);
  }

  public latestChatActivation(topicId: string): ChatActivationEvent | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM events
      WHERE type = 'chat.activation'
        AND json_extract(payload_json, '$.topicId') = ?
      ORDER BY created_at DESC, event_id DESC
      LIMIT 1
    `).get(requireText(topicId, "topicId")) as EventRow | undefined;
    if (row === undefined) return undefined;
    const event = mapEvent(row);
    if (event.type !== "chat.activation") {
      throw new Error(`Event is not chat.activation: ${event.eventId}`);
    }
    return event;
  }

  public latestChatDispatch(
    topicId: string,
    agentId: string
  ): ChatDispatchEvent | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM events
      WHERE type = 'chat.dispatch'
        AND agent_id = ?
        AND json_extract(payload_json, '$.topicId') = ?
      ORDER BY created_at DESC, event_id DESC
      LIMIT 1
    `).get(
      requireText(agentId, "agentId"),
      requireText(topicId, "topicId")
    ) as EventRow | undefined;
    if (row === undefined) return undefined;
    const event = mapEvent(row);
    if (event.type !== "chat.dispatch") {
      throw new Error(`Event is not chat.dispatch: ${event.eventId}`);
    }
    return event;
  }

  public chatMessages(topicId: string): ChatMessageEvent[] {
    return (this.#database.prepare(`
      SELECT * FROM events
      WHERE type = 'chat.message'
        AND json_extract(payload_json, '$.topicId') = ?
      ORDER BY created_at DESC, event_id DESC
    `).all(requireText(topicId, "topicId")) as unknown as EventRow[])
      .map(mapEvent)
      .filter((event): event is ChatMessageEvent => event.type === "chat.message")
      .reverse();
  }

  public chatPresence(
    agentId: string,
    topicId: string
  ): { readonly global?: ChatPresence; readonly topic?: ChatPresence } {
    const rows = this.#database.prepare(`
      SELECT * FROM chat_presence
      WHERE agent_id = ? AND (
        (scope_kind = 'global' AND scope_id = '*')
        OR (scope_kind = 'topic' AND scope_id = ?)
      )
    `).all(
      requireText(agentId, "agentId"),
      requireText(topicId, "topicId")
    ) as unknown as ChatPresenceRow[];
    const global = rows.find((row) => row.scope_kind === "global");
    const topic = rows.find((row) => row.scope_kind === "topic");
    return {
      ...(global === undefined ? {} : { global: mapChatPresence(global) }),
      ...(topic === undefined ? {} : { topic: mapChatPresence(topic) })
    };
  }

  public chatAttentionReceipts(sourceMessageEventId: string): ChatAttentionReceipt[] {
    const row = this.#database.prepare(`
      SELECT execution.receipt_json
      FROM executions AS execution
      WHERE execution.event_id = ?
    `).get(requireEventId(sourceMessageEventId, "sourceMessageEventId")) as {
      receipt_json: string | null;
    } | undefined;
    return parseChatAttentionReceiptList(row?.receipt_json ?? null);
  }

  public chatDecisionReceipt(dispatchEventId: string): ChatDecisionReceipt | undefined {
    const row = this.#database.prepare(`
      SELECT receipt_json FROM executions WHERE event_id = ?
    `).get(requireEventId(dispatchEventId, "dispatchEventId")) as {
      receipt_json: string | null;
    } | undefined;
    return parseChatDecisionReceipt(row?.receipt_json ?? null);
  }

  public execution(executionId: string): RuntimeExecution | undefined {
    const row = this.#database.prepare("SELECT * FROM executions WHERE execution_id = ?")
      .get(executionId) as ExecutionRow | undefined;
    return row === undefined ? undefined : mapExecution(row);
  }

  public executionForEvent(eventId: string): RuntimeExecution | undefined {
    const row = this.#database.prepare("SELECT * FROM executions WHERE event_id = ?")
      .get(eventId) as ExecutionRow | undefined;
    return row === undefined ? undefined : mapExecution(row);
  }

  public executionReceiptJson(executionId: string): string | null {
    const row = this.#database.prepare(
      "SELECT receipt_json FROM executions WHERE execution_id = ?"
    ).get(executionId) as { receipt_json: string | null } | undefined;
    return row?.receipt_json ?? null;
  }

  public nextDueExecutionAt(): string | undefined {
    const row = this.#database.prepare(`
      SELECT next_attempt_at FROM executions
      WHERE status IN ('queued', 'retry_wait')
      ORDER BY next_attempt_at, execution_id
      LIMIT 1
    `).get() as { next_attempt_at: string } | undefined;
    return row?.next_attempt_at;
  }

  public session(sessionId: string): RuntimeSession | undefined {
    const row = this.#database.prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  public sessionForProvider(adapterId: string, providerSessionId: string): RuntimeSession | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_sessions WHERE adapter_id = ? AND provider_session_id = ?
    `).get(
      requireText(adapterId, "adapterId"),
      requireText(providerSessionId, "providerSessionId")
    ) as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  public sessionForRunAgent(
    runId: string,
    agentId: string,
    cycleId?: string
  ): RuntimeSession | undefined {
    const row = this.#database.prepare(cycleId === undefined ? `
      SELECT * FROM agent_sessions
      WHERE run_id = ? AND cycle_id IS NULL AND agent_id = ?
    ` : `
      SELECT * FROM agent_sessions
      WHERE run_id = ? AND cycle_id = ? AND agent_id = ?
    `).get(...(cycleId === undefined
      ? [requireText(runId, "runId"), requireText(agentId, "agentId")]
      : [
          requireText(runId, "runId"),
          requireText(cycleId, "cycleId"),
          requireText(agentId, "agentId")
        ])) as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  public currentLocalAgentSession(agentId: string): RuntimeSession | undefined {
    const row = this.#database.prepare(`
      SELECT session.* FROM agents AS agent
      JOIN agent_sessions AS session
        ON session.session_id = agent.current_session_id
      WHERE agent.principal_id = ?
    `).get(requireText(agentId, "agentId")) as unknown as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  public sessions(limit = 100): RuntimeSession[] {
    return (this.#database.prepare(`
      SELECT * FROM agent_sessions ORDER BY updated_at DESC, session_id DESC LIMIT ?
    `).all(bounded(limit, 1, 1_000, "limit")) as unknown as SessionRow[]).map(mapSession);
  }

  public destination(destinationId: string): RuntimeDestination | undefined {
    const cached = this.#destinationCache.get(destinationId);
    if (cached !== undefined) return cached;
    const delivery = this.#database.prepare(`
      SELECT destination_id, destination_kind AS kind,
        destination_address_json AS address_json, created_at, updated_at
      FROM deliveries
      WHERE destination_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(destinationId) as DestinationRow | undefined;
    if (delivery !== undefined) return mapDestination(delivery);
    for (const snapshot of this.allEventDestinationSnapshots()) {
      if (snapshot.destinationId === destinationId) return snapshot;
    }
    return undefined;
  }

  public destinations(limit = 100): RuntimeDestination[] {
    const maximum = bounded(limit, 1, 1_000, "limit");
    const destinations = new Map<string, RuntimeDestination>();
    for (const destination of this.#destinationCache.values()) {
      destinations.set(destination.destinationId, destination);
    }
    for (const destination of this.allEventDestinationSnapshots()) {
      if (!destinations.has(destination.destinationId)) {
        destinations.set(destination.destinationId, destination);
      }
    }
    const rows = this.#database.prepare(`
      SELECT destination_id, destination_kind AS kind,
        destination_address_json AS address_json,
        MIN(created_at) AS created_at, MAX(updated_at) AS updated_at
      FROM deliveries
      GROUP BY destination_id, destination_kind, destination_address_json
      ORDER BY updated_at DESC, destination_id DESC
    `).all() as unknown as DestinationRow[];
    for (const row of rows) {
      const destination = mapDestination(row);
      destinations.set(destination.destinationId, destination);
    }
    return [...destinations.values()]
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.destinationId.localeCompare(left.destinationId))
      .slice(0, maximum);
  }

  public deliveriesForResultEvent(resultEventId: string): RuntimeDelivery[] {
    requireEventId(resultEventId, "resultEventId");
    return (this.#database.prepare(`
      SELECT * FROM deliveries WHERE result_event_id = ? ORDER BY created_at, delivery_id
    `).all(resultEventId) as unknown as DeliveryRow[]).map(mapDelivery);
  }

  public delivery(deliveryId: string): RuntimeDelivery | undefined {
    const row = this.#database.prepare("SELECT * FROM deliveries WHERE delivery_id = ?")
      .get(deliveryId) as DeliveryRow | undefined;
    return row === undefined ? undefined : mapDelivery(row);
  }

  public deliveriesForHostOrigin(originId: string): RuntimeDelivery[] {
    return (this.#database.prepare(`
      SELECT * FROM deliveries WHERE origin_kind = 'host' AND origin_id = ?
      ORDER BY created_at, delivery_id
    `).all(originId) as unknown as DeliveryRow[]).map(mapDelivery);
  }

  public nextDueDeliveryAt(): string | undefined {
    const row = this.#database.prepare(`
      SELECT next_attempt_at FROM deliveries
      WHERE status IN ('pending', 'retry_wait') AND attempt_count < max_attempts
      ORDER BY next_attempt_at, delivery_id
      LIMIT 1
    `).get() as { next_attempt_at: string } | undefined;
    return row?.next_attempt_at;
  }

  public deliveriesForDestinationKind(
    kind: RuntimeDestination["kind"],
    limit = 100
  ): RuntimeDelivery[] {
    return (this.#database.prepare(`
      SELECT deliveries.*
      FROM deliveries
      WHERE deliveries.destination_kind = ?
      ORDER BY deliveries.updated_at DESC, deliveries.delivery_id DESC
      LIMIT ?
    `).all(kind, bounded(limit, 1, 1_000, "limit")) as unknown as DeliveryRow[])
      .map(mapDelivery);
  }

  public resultEventForParent(parentEventId: string): AgentResultEvent | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM events
      WHERE type = 'agent.result' AND parent_event_id = ?
      ORDER BY created_at, event_id LIMIT 1
    `).get(parentEventId) as EventRow | undefined;
    if (row === undefined) return undefined;
    const event = mapEvent(row);
    if (event.type !== "agent.result") throw new Error(`Event is not agent.result: ${event.eventId}`);
    return event;
  }

  public destinationSnapshots(eventId: string): readonly DestinationSnapshot[] {
    const row = this.#database.prepare(`
      SELECT destination_snapshots_json FROM events WHERE event_id = ?
    `).get(eventId) as { destination_snapshots_json: string } | undefined;
    if (row === undefined) throw new Error(`Event not found: ${eventId}`);
    return parseDestinationSnapshots(row.destination_snapshots_json, eventId);
  }

  public allEventDestinationSnapshots(): readonly DestinationSnapshot[] {
    const rows = this.#database.prepare(`
      SELECT event_id, destination_snapshots_json
      FROM events
      WHERE destination_snapshots_json != '[]'
      ORDER BY created_at DESC, event_id DESC
    `).all() as unknown as Array<{
      event_id: string;
      destination_snapshots_json: string;
    }>;
    return rows.flatMap((row) =>
      parseDestinationSnapshots(row.destination_snapshots_json, row.event_id));
  }
}
