import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import {
  eventSourceKinds,
  eventTypes,
  isAgentInputEvent,
  newEventId,
  requireEventId,
  type AgentResultEvent,
  type AgentInputEvent,
  type CreateEvent,
  type Event,
  type ChatDispatchEvent,
  type ChatMessageEvent
} from "../event/model.js";
import {
  requireRuntimeId,
  runtimeRoute,
  runtimeId,
  type RuntimeExecution,
  type RuntimeHandlerKind,
  type RuntimeDestination,
  type RuntimeDelivery,
  type RuntimeSession
} from "./model.js";

interface EventRow {
  event_id: string;
  type: Event["type"];
  source_kind: Event["source"]["kind"];
  source_external_id: string | null;
  agent_id: string | null;
  prompt: string | null;
  outcome: AgentResultEvent["outcome"] | null;
  output: string | null;
  error: string | null;
  payload_json: string | null;
  session_id: string | null;
  destination_ids_json: string;
  root_event_id: string;
  parent_event_id: string | null;
  causal_hop: number;
  created_at: string;
}

interface ExecutionRow {
  execution_id: string;
  event_id: string;
  handler: RuntimeHandlerKind;
  status: RuntimeExecution["status"];
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface SessionRow {
  session_id: string;
  agent_id: string;
  adapter_id: string;
  provider_session_id: string;
  workspace: string;
  created_at: string;
  updated_at: string;
}

interface DestinationRow {
  destination_id: string;
  kind: "matrix";
  address_json: string;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  result_event_id: string;
  destination_id: string;
  status: RuntimeDelivery["status"];
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  receipt: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppendRuntimeEventReceipt {
  readonly event: Event;
  readonly execution: RuntimeExecution;
  readonly status: "accepted" | "duplicate";
}

export interface CompleteRuntimeExecution {
  readonly adapterId: string;
  readonly workspace: string;
  readonly providerSessionId: string;
  readonly sessionId?: string;
  readonly output?: string;
}

export type RuntimeExecutionOutcome = AgentResultEvent | ChatMessageEvent | undefined;

export interface RuntimeAudit {
  readonly event: Event;
  readonly execution?: RuntimeExecution;
  readonly resultEvent?: AgentResultEvent;
  readonly resultExecution?: RuntimeExecution;
  readonly session?: RuntimeSession;
  readonly deliveries: ReadonlyArray<{
    readonly delivery: RuntimeDelivery;
    readonly destination: RuntimeDestination;
  }>;
}

export class RuntimeStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.#database = openRuntimeDatabase(absolutePath);
    this.#migrate();
  }

  public appendEvent(input: CreateEvent): AppendRuntimeEventReceipt {
    validateCreateEvent(input);
    const createdAt = iso(input.createdAt ?? new Date().toISOString());
    const maxAttempts = bounded(input.maxAttempts ?? 3, 1, 20, "maxAttempts");
    const eventId = input.eventId === undefined ? newEventId() : requireEventId(input.eventId);
    const executionId = runtimeId("exe");
    const route = runtimeRoute(input.type);
    const destinations = [...new Set(input.destinationIds ?? [])];
    for (const destinationId of destinations) requireRuntimeId(destinationId, "dst", "destinationId");
    if (input.sessionId !== undefined) requireRuntimeId(input.sessionId, "ses", "sessionId");
    const rootEventId = input.parent?.rootEventId ?? eventId;
    const parentEventId = input.parent?.eventId;
    const hop = input.parent === undefined ? 0 : input.parent.hop + 1;
    if (parentEventId !== undefined) {
      requireRuntimeId(parentEventId, "evt", "parent.eventId");
      requireRuntimeId(rootEventId, "evt", "parent.rootEventId");
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (input.source.externalId !== undefined) {
        const existing = this.#database.prepare(`
          SELECT event_id FROM events WHERE source_kind = ? AND source_external_id = ?
        `).get(input.source.kind, input.source.externalId) as { event_id: string } | undefined;
        if (existing !== undefined) {
          const receipt = this.#receipt(existing.event_id, "duplicate");
          this.#database.exec("COMMIT");
          return receipt;
        }
      }
      this.#database.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, source_external_id, agent_id, prompt,
          outcome, output, error, session_id, destination_ids_json,
          root_event_id, parent_event_id, causal_hop, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId, input.type, input.source.kind, input.source.externalId ?? null,
        input.agentId, input.prompt, input.sessionId ?? null, JSON.stringify(destinations),
        rootEventId, parentEventId ?? null, hop, createdAt
      );
      this.#database.prepare(`
        INSERT INTO executions (
          execution_id, event_id, handler, status, attempt_count, max_attempts,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)
      `).run(executionId, eventId, route.handler, maxAttempts, createdAt, createdAt, createdAt);
      const receipt = this.#receipt(eventId, "accepted");
      this.#database.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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

  public audit(eventId: string): RuntimeAudit | undefined {
    const event = this.event(eventId);
    if (event === undefined) return undefined;
    const execution = this.executionForEvent(eventId);
    const resultEvent = event.type === "agent.result"
      ? event
      : this.#resultEventForParent(event.eventId);
    const sessionId = resultEvent?.sessionId ?? event.sessionId;
    const session = sessionId === undefined ? undefined : this.session(sessionId);
    const resultExecution = resultEvent === undefined || resultEvent.eventId === event.eventId
      ? undefined
      : this.executionForEvent(resultEvent.eventId);
    const deliveries = resultEvent === undefined ? [] :
      this.deliveriesForResultEvent(resultEvent.eventId).map((delivery) => {
      const destination = this.destination(delivery.destinationId);
      if (destination === undefined) throw new Error(`Destination not found: ${delivery.destinationId}`);
      return { delivery, destination };
    });
    return {
      event,
      ...(execution === undefined ? {} : { execution }),
      ...(resultEvent === undefined ? {} : { resultEvent }),
      ...(resultExecution === undefined ? {} : { resultExecution }),
      ...(session === undefined ? {} : { session }),
      deliveries
    };
  }

  public audits(limit = 100): RuntimeAudit[] {
    return this.events(limit).map((event) => this.audit(event.eventId)!);
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

  public claimDueExecutions(
    limit = 20,
    now = new Date().toISOString()
  ): RuntimeExecution[] {
    const timestamp = iso(now);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#database.prepare(`
        SELECT execution_id FROM executions
        WHERE status IN ('queued', 'retry_wait') AND julianday(next_attempt_at) <= julianday(?)
        ORDER BY next_attempt_at ASC, created_at ASC, execution_id ASC LIMIT ?
      `).all(timestamp, bounded(limit, 1, 100, "limit")) as unknown as Array<{ execution_id: string }>;
      const claimed: RuntimeExecution[] = [];
      for (const row of rows) {
        const changed = this.#database.prepare(`
          UPDATE executions SET status = 'running', attempt_count = attempt_count + 1,
            started_at = ?, updated_at = ?
          WHERE execution_id = ? AND status IN ('queued', 'retry_wait')
        `).run(timestamp, timestamp, row.execution_id);
        if (changed.changes === 1) claimed.push(this.#requireExecution(row.execution_id));
      }
      this.#database.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public completeExecution(
    executionId: string,
    receipt: CompleteRuntimeExecution,
    at = new Date().toISOString()
  ): RuntimeExecutionOutcome {
    requireText(receipt.adapterId, "adapterId");
    requireText(receipt.workspace, "workspace");
    requireText(receipt.providerSessionId, "providerSessionId");
    const timestamp = iso(at);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.#requireExecution(executionId);
      if (execution.status !== "running") throw new Error(`execution is not running: ${executionId}`);
      if (execution.handler !== "agent") {
        throw new Error(`only AgentHandler can complete with provider receipt: ${executionId}`);
      }
      const event = this.#requireEvent(execution.eventId);
      if (event.type === "agent.result" || event.type === "chat.message") {
        throw new Error(`AgentHandler cannot complete ${event.type}: ${event.eventId}`);
      }
      if (event.type !== "chat.dispatch" && receipt.output === undefined) {
        throw new Error(`Agent outcome must include a message: ${event.eventId}`);
      }
      if (event.sessionId !== undefined && receipt.sessionId !== undefined &&
        event.sessionId !== receipt.sessionId) {
        throw new Error(`Execution Session changed while handling Event: ${event.eventId}`);
      }
      const sessionId = event.sessionId ?? receipt.sessionId;
      let session: RuntimeSession;
      if (sessionId === undefined) {
        session = this.#createSession(event.agentId, receipt, timestamp);
      } else {
        session = this.#requireSession(sessionId);
        if (session.agentId !== event.agentId || session.adapterId !== receipt.adapterId ||
          session.workspace !== receipt.workspace || session.providerSessionId !== receipt.providerSessionId) {
          throw new Error(`Session changed while handling Event: ${sessionId}`);
        }
        this.#database.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
          .run(timestamp, session.sessionId);
      }
      this.#database.prepare(`
        UPDATE executions SET status = 'succeeded', completed_at = ?, updated_at = ?, last_error = NULL
        WHERE execution_id = ?
      `).run(timestamp, timestamp, executionId);
      if (event.type === "chat.dispatch") {
        this.#database.prepare(`
          INSERT INTO local_agent_sessions (principal_id, current_session_id, generation, updated_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(principal_id) DO UPDATE SET
            current_session_id = excluded.current_session_id,
            updated_at = excluded.updated_at
        `).run(event.agentId, session.sessionId, timestamp);
        const reply = receipt.output === undefined || receipt.output.trim() === ""
          ? undefined
          : this.#createChatReply(event, session.sessionId, receipt.output, timestamp);
        this.#database.exec("COMMIT");
        return reply;
      }
      const resultEvent = this.#createResultEvent({
        execution,
        event,
        outcome: "succeeded",
        sessionId: session.sessionId,
        output: receipt.output!,
        at: timestamp
      });
      this.#database.exec("COMMIT");
      return resultEvent;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public failExecution(
    executionId: string,
    error: string,
    at = new Date().toISOString(),
    retryBaseMilliseconds = 1_000
  ): { readonly execution: RuntimeExecution; readonly resultEvent?: AgentResultEvent } {
    const failure = requireText(error, "error").slice(0, 4_096);
    const timestamp = iso(at);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.#requireExecution(executionId);
      if (execution.status !== "running") throw new Error(`execution is not running: ${executionId}`);
      if (execution.attemptCount < execution.maxAttempts) {
        const next = annealedRetryAt(timestamp, execution.attemptCount, retryBaseMilliseconds);
        this.#database.prepare(`
          UPDATE executions SET status = 'retry_wait', next_attempt_at = ?, last_error = ?,
            started_at = NULL, updated_at = ? WHERE execution_id = ?
        `).run(next, failure, timestamp, executionId);
        const retried = this.#requireExecution(executionId);
        this.#database.exec("COMMIT");
        return { execution: retried };
      }
      this.#database.prepare(`
        UPDATE executions SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?
        WHERE execution_id = ?
      `).run(failure, timestamp, timestamp, executionId);
      const event = this.#requireEvent(execution.eventId);
      const failed = this.#requireExecution(executionId);
      const resultEvent = execution.handler === "agent" &&
        isAgentInputEvent(event) &&
        event.type !== "chat.dispatch"
        ? this.#createResultEvent({
          execution,
          event,
          outcome: "failed",
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          error: failure,
          at: timestamp
        })
        : undefined;
      this.#database.exec("COMMIT");
      return {
        execution: failed,
        ...(resultEvent === undefined ? {} : { resultEvent })
      };
    } catch (error_) {
      this.#database.exec("ROLLBACK");
      throw error_;
    }
  }

  public completeResultExecution(
    executionId: string,
    at = new Date().toISOString()
  ): RuntimeDelivery[] {
    const timestamp = iso(at);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.#requireExecution(executionId);
      if (execution.status !== "running" || execution.handler !== "result") {
        throw new Error(`result execution is not running: ${executionId}`);
      }
      const resultEvent = this.#requireEvent(execution.eventId);
      if (resultEvent.type !== "agent.result") {
        throw new Error(`ResultHandler requires agent.result: ${resultEvent.eventId}`);
      }
      for (const destinationId of resultEvent.destinationIds) {
        this.#requireDestination(destinationId);
        this.#database.prepare(`
          INSERT INTO deliveries (
            delivery_id, result_event_id, destination_id, status, attempt_count, max_attempts,
            next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', 0, 5, ?, ?, ?)
          ON CONFLICT(result_event_id, destination_id) DO NOTHING
        `).run(runtimeId("del"), resultEvent.eventId, destinationId,
          timestamp, timestamp, timestamp);
      }
      this.#database.prepare(`
        UPDATE executions SET status = 'succeeded', completed_at = ?, updated_at = ?,
          last_error = NULL WHERE execution_id = ?
      `).run(timestamp, timestamp, executionId);
      const deliveries = this.deliveriesForResultEvent(resultEvent.eventId);
      this.#database.exec("COMMIT");
      return deliveries;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public session(sessionId: string): RuntimeSession | undefined {
    const row = this.#database.prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  public sessionForProvider(
    adapterId: string,
    providerSessionId: string
  ): RuntimeSession | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM sessions WHERE adapter_id = ? AND provider_session_id = ?
    `).get(
      requireText(adapterId, "adapterId"),
      requireText(providerSessionId, "providerSessionId")
    ) as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  public currentLocalAgentSession(agentId: string): RuntimeSession | undefined {
    const row = this.#database.prepare(`
      SELECT s.* FROM local_agent_sessions AS current
      JOIN sessions AS s ON s.session_id = current.current_session_id
      WHERE current.principal_id = ?
    `).get(requireText(agentId, "agentId")) as unknown as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  public sessions(limit = 100): RuntimeSession[] {
    return (this.#database.prepare(`
      SELECT * FROM sessions ORDER BY updated_at DESC, session_id DESC LIMIT ?
    `).all(bounded(limit, 1, 1_000, "limit")) as unknown as SessionRow[]).map(mapSession);
  }

  public putDestination(input: {
    readonly destinationId?: string;
    readonly kind: "matrix";
    readonly address: Readonly<Record<string, string>>;
    readonly at?: string;
  }): RuntimeDestination {
    const destinationId = input.destinationId ?? runtimeId("dst");
    requireRuntimeId(destinationId, "dst", "destinationId");
    validateAddress(input.address);
    const timestamp = iso(input.at ?? new Date().toISOString());
    this.#database.prepare(`
      INSERT INTO destinations (destination_id, kind, address_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(destination_id) DO UPDATE SET
        kind = excluded.kind, address_json = excluded.address_json, updated_at = excluded.updated_at
    `).run(destinationId, input.kind, JSON.stringify(input.address), timestamp, timestamp);
    return this.#requireDestination(destinationId);
  }

  public destination(destinationId: string): RuntimeDestination | undefined {
    const row = this.#database.prepare("SELECT * FROM destinations WHERE destination_id = ?")
      .get(destinationId) as DestinationRow | undefined;
    return row === undefined ? undefined : mapDestination(row);
  }

  public destinations(limit = 100): RuntimeDestination[] {
    return (this.#database.prepare(`
      SELECT * FROM destinations ORDER BY updated_at DESC, destination_id DESC LIMIT ?
    `).all(bounded(limit, 1, 1_000, "limit")) as unknown as DestinationRow[]).map(mapDestination);
  }

  public deliveriesForResultEvent(resultEventId: string): RuntimeDelivery[] {
    requireEventId(resultEventId, "resultEventId");
    return (this.#database.prepare(`
      SELECT * FROM deliveries WHERE result_event_id = ? ORDER BY created_at, delivery_id
    `).all(resultEventId) as unknown as DeliveryRow[]).map(mapDelivery);
  }

  public claimDueDeliveries(
    limit = 100,
    now = new Date().toISOString()
  ): RuntimeDelivery[] {
    const timestamp = iso(now);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#database.prepare(`
        SELECT delivery_id FROM deliveries
        WHERE status IN ('pending', 'retry_wait') AND julianday(next_attempt_at) <= julianday(?)
        ORDER BY next_attempt_at, created_at, delivery_id LIMIT ?
      `).all(timestamp, bounded(limit, 1, 500, "limit")) as unknown as Array<{ delivery_id: string }>;
      const claimed: RuntimeDelivery[] = [];
      for (const row of rows) {
        const changed = this.#database.prepare(`
          UPDATE deliveries SET status = 'delivering', attempt_count = attempt_count + 1,
            updated_at = ? WHERE delivery_id = ? AND status IN ('pending', 'retry_wait')
        `).run(timestamp, row.delivery_id);
        if (changed.changes === 1) claimed.push(this.#requireDelivery(row.delivery_id));
      }
      this.#database.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public deliverySucceeded(
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

  public deliveryFailed(
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
    `).run(exhausted ? "failed" : "retry_wait", nextAttemptAt,
      requireText(error, "error").slice(0, 4_096), timestamp, deliveryId);
    return this.#requireDelivery(deliveryId);
  }

  public delivery(deliveryId: string): RuntimeDelivery | undefined {
    const row = this.#database.prepare("SELECT * FROM deliveries WHERE delivery_id = ?")
      .get(deliveryId) as DeliveryRow | undefined;
    return row === undefined ? undefined : mapDelivery(row);
  }

  public reconcileInterrupted(at = new Date().toISOString()): number {
    const timestamp = iso(at);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const executions = this.#database.prepare(`
        UPDATE executions SET status = 'retry_wait', next_attempt_at = ?,
          last_error = 'runtime_interrupted', started_at = NULL, updated_at = ?
        WHERE status = 'running'
      `).run(timestamp, timestamp).changes;
      const deliveries = this.#database.prepare(`
        UPDATE deliveries SET status = 'retry_wait', next_attempt_at = ?,
          last_error = 'runtime_interrupted', updated_at = ?
        WHERE status = 'delivering'
      `).run(timestamp, timestamp).changes;
      this.#database.exec("COMMIT");
      return Number(executions) + Number(deliveries);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public close(): void {
    this.#database.close();
  }

  #receipt(eventId: string, status: AppendRuntimeEventReceipt["status"]): AppendRuntimeEventReceipt {
    const event = this.#requireEvent(eventId);
    const row = this.#database.prepare("SELECT * FROM executions WHERE event_id = ?")
      .get(eventId) as ExecutionRow | undefined;
    if (row === undefined) throw new Error(`Event has no Execution: ${eventId}`);
    return { event, execution: mapExecution(row), status };
  }

  #createSession(
    agentId: string,
    receipt: CompleteRuntimeExecution,
    timestamp: string
  ): RuntimeSession {
    const sessionId = runtimeId("ses");
    this.#database.prepare(`
      INSERT INTO sessions (
        session_id, agent_id, adapter_id, provider_session_id, workspace, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, agentId, receipt.adapterId, receipt.providerSessionId,
      receipt.workspace, timestamp, timestamp);
    return this.#requireSession(sessionId);
  }

  #requireEvent(eventId: string): Event {
    const event = this.event(eventId);
    if (event === undefined) throw new Error(`Event not found: ${eventId}`);
    return event;
  }

  #requireExecution(executionId: string): RuntimeExecution {
    const execution = this.execution(executionId);
    if (execution === undefined) throw new Error(`Execution not found: ${executionId}`);
    return execution;
  }

  #requireSession(sessionId: string): RuntimeSession {
    const session = this.session(sessionId);
    if (session === undefined) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  #requireDestination(destinationId: string): RuntimeDestination {
    const destination = this.destination(destinationId);
    if (destination === undefined) throw new Error(`Destination not found: ${destinationId}`);
    return destination;
  }

  #requireDelivery(deliveryId: string): RuntimeDelivery {
    const delivery = this.delivery(deliveryId);
    if (delivery === undefined) throw new Error(`Delivery not found: ${deliveryId}`);
    return delivery;
  }

  #resultEventForParent(parentEventId: string): AgentResultEvent | undefined {
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

  #createResultEvent(input: {
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
        outcome, output, error, session_id, destination_ids_json,
        root_event_id, parent_event_id, causal_hop, created_at
      ) VALUES (?, 'agent.result', 'handler', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.execution.executionId,
      input.event.agentId,
      input.outcome,
      input.output ?? null,
      input.error ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.event.destinationIds),
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
    const event = this.#requireEvent(eventId);
    if (event.type !== "agent.result") throw new Error(`Event is not agent.result: ${eventId}`);
    return event;
  }

  #createChatReply(
    dispatch: ChatDispatchEvent,
    sessionId: string,
    body: string,
    at: string
  ): ChatMessageEvent {
    const eventId = newEventId();
    const payload = {
      topicId: dispatch.topicId,
      sender: {
        kind: "agent",
        principalId: dispatch.agentId,
        handleSnapshot: dispatch.targetHandleSnapshot
      },
      body
    };
    this.#database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        root_event_id, parent_event_id, causal_hop, created_at
      ) VALUES (?, 'chat.message', 'handler', ?, ?, NULL, NULL, NULL, NULL, ?, ?, '[]',
        ?, ?, ?, ?)
    `).run(
      eventId,
      dispatch.eventId,
      dispatch.agentId,
      JSON.stringify(payload),
      sessionId,
      dispatch.causality.rootEventId,
      dispatch.eventId,
      dispatch.causality.hop + 1,
      at
    );
    const event = this.#requireEvent(eventId);
    if (event.type !== "chat.message") throw new Error(`Event is not chat.message: ${eventId}`);
    return event;
  }

  #migrate(): void {
    this.#resetIncompatibleCore();
    this.#migrateLocalChatEvents();
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN (
          'agent.request', 'subscription.fire', 'agent.result', 'chat.message', 'chat.dispatch'
        )),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('cli', 'subscription', 'matrix', 'server', 'handler')),
        source_external_id TEXT,
        agent_id TEXT,
        prompt TEXT,
        outcome TEXT CHECK(outcome IN ('succeeded', 'failed')),
        output TEXT,
        error TEXT,
        payload_json TEXT,
        session_id TEXT REFERENCES sessions(session_id),
        destination_ids_json TEXT NOT NULL,
        root_event_id TEXT NOT NULL,
        parent_event_id TEXT,
        causal_hop INTEGER NOT NULL CHECK(causal_hop >= 0),
        created_at TEXT NOT NULL,
        CHECK(
          (type IN ('agent.request', 'subscription.fire') AND agent_id IS NOT NULL
            AND prompt IS NOT NULL AND outcome IS NULL AND output IS NULL
            AND error IS NULL AND payload_json IS NULL)
          OR
          (type = 'agent.result' AND agent_id IS NOT NULL AND prompt IS NULL
            AND outcome IS NOT NULL AND payload_json IS NULL
            AND ((outcome = 'succeeded' AND output IS NOT NULL AND error IS NULL)
              OR (outcome = 'failed' AND output IS NULL AND error IS NOT NULL)))
          OR
          (type = 'chat.message' AND prompt IS NULL AND outcome IS NULL
            AND output IS NULL AND error IS NULL AND payload_json IS NOT NULL)
          OR
          (type = 'chat.dispatch' AND agent_id IS NOT NULL AND prompt IS NOT NULL
            AND outcome IS NULL AND output IS NULL AND error IS NULL
            AND payload_json IS NOT NULL)
        ),
        UNIQUE(source_kind, source_external_id)
      );
      CREATE INDEX IF NOT EXISTS events_causal ON events(root_event_id, causal_hop, created_at);
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        handler TEXT NOT NULL CHECK(handler IN ('agent', 'result')),
        status TEXT NOT NULL CHECK(status IN ('queued','running','retry_wait','succeeded','failed')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS executions_due ON executions(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(adapter_id, provider_session_id)
      );
      CREATE TABLE IF NOT EXISTS destinations (
        destination_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind = 'matrix'),
        address_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        result_event_id TEXT NOT NULL REFERENCES events(event_id),
        destination_id TEXT NOT NULL REFERENCES destinations(destination_id),
        status TEXT NOT NULL CHECK(status IN ('pending','delivering','retry_wait','delivered','failed')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
        next_attempt_at TEXT NOT NULL,
        receipt TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(result_event_id, destination_id)
      );
      CREATE INDEX IF NOT EXISTS deliveries_due
        ON deliveries(status, next_attempt_at);
    `);
  }

  #migrateLocalChatEvents(): void {
    const row = this.#database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'
    `).get() as { sql: string | null } | undefined;
    if (row?.sql === null || row?.sql === undefined || !row.sql.includes("'room.message'")) {
      return;
    }
    this.#database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE events_v33 (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN (
          'agent.request', 'subscription.fire', 'agent.result', 'chat.message', 'chat.dispatch'
        )),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('cli', 'subscription', 'matrix', 'server', 'handler')),
        source_external_id TEXT,
        agent_id TEXT,
        prompt TEXT,
        outcome TEXT CHECK(outcome IN ('succeeded', 'failed')),
        output TEXT,
        error TEXT,
        payload_json TEXT,
        session_id TEXT REFERENCES sessions(session_id),
        destination_ids_json TEXT NOT NULL,
        root_event_id TEXT NOT NULL,
        parent_event_id TEXT,
        causal_hop INTEGER NOT NULL CHECK(causal_hop >= 0),
        created_at TEXT NOT NULL,
        CHECK(
          (type IN ('agent.request', 'subscription.fire') AND agent_id IS NOT NULL
            AND prompt IS NOT NULL AND outcome IS NULL AND output IS NULL
            AND error IS NULL AND payload_json IS NULL)
          OR
          (type = 'agent.result' AND agent_id IS NOT NULL AND prompt IS NULL
            AND outcome IS NOT NULL AND payload_json IS NULL
            AND ((outcome = 'succeeded' AND output IS NOT NULL AND error IS NULL)
              OR (outcome = 'failed' AND output IS NULL AND error IS NOT NULL)))
          OR
          (type = 'chat.message' AND prompt IS NULL AND outcome IS NULL
            AND output IS NULL AND error IS NULL AND payload_json IS NOT NULL)
          OR
          (type = 'chat.dispatch' AND agent_id IS NOT NULL AND prompt IS NOT NULL
            AND outcome IS NULL AND output IS NULL AND error IS NULL
            AND payload_json IS NOT NULL)
        ),
        UNIQUE(source_kind, source_external_id)
      );
      INSERT INTO events_v33 (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        root_event_id, parent_event_id, causal_hop, created_at
      )
      SELECT
        event_id,
        CASE type
          WHEN 'room.message' THEN 'chat.message'
          WHEN 'room.dispatch' THEN 'chat.dispatch'
          ELSE type
        END,
        source_kind,
        CASE
          WHEN source_external_id LIKE 'local-room-dispatch:%'
            THEN 'local-chat-dispatch:' || substr(source_external_id, 21)
          ELSE source_external_id
        END,
        agent_id,
        prompt,
        outcome,
        output,
        error,
        CASE
          WHEN type IN ('room.message', 'room.dispatch')
            THEN json_remove(
              json_set(payload_json, '$.topicId', json_extract(payload_json, '$.roomId')),
              '$.roomId'
            )
          ELSE payload_json
        END,
        session_id,
        destination_ids_json,
        root_event_id,
        parent_event_id,
        causal_hop,
        created_at
      FROM events;
      DROP TABLE events;
      ALTER TABLE events_v33 RENAME TO events;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  #resetIncompatibleCore(): void {
    const expectedColumns = new Map<string, readonly string[]>([
      ["events", ["event_id", "type", "destination_ids_json", "payload_json"]],
      ["executions", ["execution_id", "event_id", "handler"]],
      ["sessions", ["session_id", "provider_session_id"]],
      ["destinations", ["destination_id", "kind", "address_json"]],
      ["deliveries", ["delivery_id", "result_event_id", "destination_id"]]
    ]);
    const tables = new Set((this.#database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    const hasIntermediateRouteSchema = tables.has("routes") || tables.has("route_deliveries");
    const incompatible = hasIntermediateRouteSchema || tables.has("results") ||
      [...expectedColumns].some(([table, columns]) => {
      if (!tables.has(table)) return false;
      const actual = new Set((this.#database.prepare(`PRAGMA table_info(${table})`).all() as unknown as
        Array<{ name: string }>).map((row) => row.name));
      return columns.some((column) => !actual.has(column)) ||
        (table === "events" && (!actual.has("outcome") || actual.has("handler")));
      });
    if (!incompatible) return;
    this.#database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS matrix_bindings;
      DROP TABLE IF EXISTS poll_subscriptions;
      DROP TABLE IF EXISTS route_deliveries;
      DROP TABLE IF EXISTS deliveries;
      DROP TABLE IF EXISTS results;
      DROP TABLE IF EXISTS executions;
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS routes;
      DROP TABLE IF EXISTS destinations;
      DROP TABLE IF EXISTS sessions;
      PRAGMA foreign_keys = ON;
    `);
  }
}

export function annealedRetryAt(
  at: string,
  attempt: number,
  baseMilliseconds: number,
  maximumMilliseconds = 300_000
): string {
  bounded(attempt, 1, 30, "attempt");
  bounded(baseMilliseconds, 1, 86_400_000, "baseMilliseconds");
  bounded(maximumMilliseconds, 1, 86_400_000, "maximumMilliseconds");
  const delay = Math.min(maximumMilliseconds, baseMilliseconds * (2 ** (attempt - 1)));
  return new Date(Date.parse(iso(at)) + delay).toISOString();
}

function validateCreateEvent(input: CreateEvent): void {
  if (!eventTypes.includes(input.type)) throw new Error(`unsupported Event type: ${input.type}`);
  if (!eventSourceKinds.includes(input.source.kind)) {
    throw new Error(`unsupported Event source: ${input.source.kind}`);
  }
  requireText(input.agentId, "agentId");
  requireText(input.prompt, "prompt");
  if (input.source.externalId !== undefined) requireText(input.source.externalId, "source.externalId");
  if (input.parent !== undefined) bounded(input.parent.hop, 0, 1_000, "parent.hop");
}

function validateAddress(address: Readonly<Record<string, string>>): void {
  if (Object.keys(address).length === 0) throw new Error("Destination address must not be empty");
  for (const [key, value] of Object.entries(address)) {
    requireText(key, "Destination address key");
    requireText(value, `Destination address ${key}`);
  }
}

function mapEvent(row: EventRow): Event {
  const destinations = JSON.parse(row.destination_ids_json) as unknown;
  if (!Array.isArray(destinations) || destinations.some((destination) => typeof destination !== "string")) {
    throw new Error(`Event destination IDs are malformed: ${row.event_id}`);
  }
  const common = {
    eventId: row.event_id,
    source: {
      kind: row.source_kind,
      ...(row.source_external_id === null ? {} : { externalId: row.source_external_id })
    },
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    destinationIds: destinations as string[],
    causality: {
      rootEventId: row.root_event_id,
      ...(row.parent_event_id === null ? {} : { parentEventId: row.parent_event_id }),
      hop: row.causal_hop
    },
    createdAt: row.created_at
  };
  if (row.type === "chat.message") {
    const payload = chatPayload(row);
    const sender = payload.sender;
    if (!isRecord(sender) ||
      (sender.kind !== "owner" && sender.kind !== "agent" && sender.kind !== "system") ||
      typeof sender.handleSnapshot !== "string") {
      throw new Error(`Chat message sender is malformed: ${row.event_id}`);
    }
    const target = payload.target;
    if (target !== undefined && (!isRecord(target) ||
      typeof target.principalId !== "string" ||
      typeof target.handleSnapshot !== "string")) {
      throw new Error(`Chat message target is malformed: ${row.event_id}`);
    }
    const dispatchCard = payload.dispatchCard;
    if (dispatchCard !== undefined && (!isRecord(dispatchCard) ||
      typeof dispatchCard.sourceMessageEventId !== "string" ||
      !Array.isArray(dispatchCard.candidates) ||
      dispatchCard.candidates.some((candidate) => !isRecord(candidate) ||
        typeof candidate.principalId !== "string" ||
        typeof candidate.handle !== "string"))) {
      throw new Error(`Chat dispatch card is malformed: ${row.event_id}`);
    }
    return {
      ...common,
      type: "chat.message",
      topicId: requirePayloadText(payload.topicId, row.event_id, "topicId"),
      sender: {
        kind: sender.kind,
        ...(typeof sender.principalId === "string"
          ? { principalId: sender.principalId }
          : {}),
        handleSnapshot: sender.handleSnapshot
      },
      body: requirePayloadText(payload.body, row.event_id, "body"),
      ...(target === undefined
        ? {}
        : {
            target: {
              principalId: target.principalId as string,
              handleSnapshot: target.handleSnapshot as string
            }
          }),
      ...(dispatchCard === undefined
        ? {}
        : {
            dispatchCard: {
              sourceMessageEventId: dispatchCard.sourceMessageEventId as string,
              candidates: (dispatchCard.candidates as Array<{
                principalId: string;
                handle: string;
              }>).map(({ principalId, handle }) => ({ principalId, handle }))
            }
          })
    };
  }
  if (row.type === "chat.dispatch") {
    if (row.agent_id === null || row.prompt === null) {
      throw new Error(`Chat dispatch is missing Agent input: ${row.event_id}`);
    }
    const payload = chatPayload(row);
    return {
      ...common,
      type: "chat.dispatch",
      agentId: row.agent_id,
      topicId: requirePayloadText(payload.topicId, row.event_id, "topicId"),
      sourceMessageEventId: requirePayloadText(
        payload.sourceMessageEventId,
        row.event_id,
        "sourceMessageEventId"
      ),
      targetHandleSnapshot: requirePayloadText(
        payload.targetHandleSnapshot,
        row.event_id,
        "targetHandleSnapshot"
      ),
      prompt: row.prompt
    };
  }
  if (row.type === "agent.result") {
    if (row.outcome === null || row.agent_id === null) {
      throw new Error(`Result Event is incomplete: ${row.event_id}`);
    }
    return {
      ...common,
      type: "agent.result",
      agentId: row.agent_id,
      outcome: row.outcome,
      ...(row.output === null ? {} : { output: row.output }),
      ...(row.error === null ? {} : { error: row.error })
    };
  }
  if (row.prompt === null) throw new Error(`Input Event has no prompt: ${row.event_id}`);
  return {
    ...common,
    type: row.type,
    agentId: row.agent_id!,
    prompt: row.prompt
  };
}

function chatPayload(row: EventRow): Readonly<Record<string, unknown>> {
  if (row.payload_json === null) {
    throw new Error(`Chat Event payload is missing: ${row.event_id}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error(`Chat Event payload is malformed: ${row.event_id}`);
  }
  if (!isRecord(value)) throw new Error(`Chat Event payload is not an object: ${row.event_id}`);
  return value;
}

function requirePayloadText(
  value: unknown,
  eventId: string,
  field: string
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Chat Event ${field} is malformed: ${eventId}`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapExecution(row: ExecutionRow): RuntimeExecution {
  return {
    executionId: row.execution_id,
    eventId: row.event_id,
    handler: row.handler,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at
  };
}

function mapSession(row: SessionRow): RuntimeSession {
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    adapterId: row.adapter_id,
    providerSessionId: row.provider_session_id,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDestination(row: DestinationRow): RuntimeDestination {
  return {
    destinationId: row.destination_id,
    kind: row.kind,
    address: JSON.parse(row.address_json) as Readonly<Record<string, string>>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDelivery(row: DeliveryRow): RuntimeDelivery {
  return {
    deliveryId: row.delivery_id,
    resultEventId: row.result_event_id,
    destinationId: row.destination_id,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.receipt === null ? {} : { receipt: row.receipt }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function iso(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error("timestamp must be ISO-8601");
  return new Date(timestamp).toISOString();
}

function requireText(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
