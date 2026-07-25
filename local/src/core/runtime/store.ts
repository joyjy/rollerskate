import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import {
  mapChatAttentionReceipt,
  mapChatDecisionReceipt,
  mapChatPresence,
  mapDelivery,
  mapDestination,
  mapEvent,
  mapExecution,
  mapSession,
  validateReviewInvocation,
  type ChatAttentionReceiptRow,
  type ChatDecisionReceiptRow,
  type ChatPresenceRow,
  type DeliveryRow,
  type DestinationRow,
  type EventRow,
  type ExecutionRow,
  type SessionRow
} from "../../infrastructure/sqlite/runtime-mappers.js";
import { migrateRuntimeDatabase } from "../../infrastructure/sqlite/runtime-schema.js";
export type {
  ChatAttentionReceipt,
  ChatDecisionReceipt
} from "../../infrastructure/sqlite/runtime-mappers.js";
import type {
  ChatAttentionReceipt,
  ChatDecisionReceipt
} from "../../infrastructure/sqlite/runtime-mappers.js";
import {
  chatMentionPromptResourceId,
  chatPromptResourceId,
  parseChatPresence,
  type ChatPresence,
  type ChatTurnDecision
} from "../chat/model.js";
import type {
  ChatAttentionPlan,
  ChatAttentionReason
} from "../chat/state-machine.js";
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
  readonly chatDecision?: ChatTurnDecision;
}

export type RuntimeExecutionOutcome = AgentResultEvent | ChatMessageEvent | undefined;

export interface AdmitChatAttention {
  readonly plan: ChatAttentionPlan;
  readonly prompt?: string;
  readonly promptResourceId?: string;
}

interface DestinationSnapshot {
  readonly destinationId: string;
  readonly kind: RuntimeDestination["kind"];
  readonly address: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

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
  readonly chat?: {
    readonly promptResourceId?: string;
    readonly attentionReceipts: readonly ChatAttentionReceipt[];
    readonly decisionReceipt?: ChatDecisionReceipt;
  };
}

export class RuntimeStore {
  readonly #database: DatabaseSync;
  readonly #destinationCache = new Map<string, RuntimeDestination>();

  public constructor(databasePath: string) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.#database = openRuntimeDatabase(absolutePath);
    migrateRuntimeDatabase(this.#database);
  }

  public appendEvent(input: CreateEvent): AppendRuntimeEventReceipt {
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
    for (const destinationId of destinations) requireRuntimeId(destinationId, "dst", "destinationId");
    const destinationSnapshots = destinations.map((destinationId) => {
      const destination = this.destination(destinationId);
      if (destination === undefined) {
        throw new Error(`Destination not found: ${destinationId}`);
      }
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
          outcome, output, error, payload_json, session_id, destination_ids_json,
          destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId, input.type, input.source.kind, input.source.externalId ?? null,
        input.agentId, input.prompt,
        input.reviewInvocation === undefined ? null : JSON.stringify(input.reviewInvocation),
        input.sessionId ?? null, JSON.stringify(destinations),
        JSON.stringify(destinationSnapshots),
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

  public chatMessages(topicId: string): ChatMessageEvent[] {
    return (this.#database.prepare(`
      SELECT * FROM events
      WHERE type = 'chat.message'
        AND json_extract(payload_json, '$.topicId') = ?
      ORDER BY created_at DESC, event_id DESC
    `).all(requireText(topicId, "topicId")) as
      unknown as EventRow[])
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

  public setChatPresence(
    agentId: string,
    topicId: string,
    presenceInput: ChatPresence,
    at = new Date().toISOString()
  ): ChatPresence {
    const timestamp = iso(at);
    const presence = parseChatPresence(presenceInput, timestamp);
    const scopeId = presence.scope === "global" ? "*" : requireText(topicId, "topicId");
    this.#database.prepare(`
      INSERT INTO chat_presence (
        agent_id, scope_kind, scope_id, mode, until_at, wake_keywords_json,
        revision, updated_by_dispatch_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
      ON CONFLICT(agent_id, scope_kind, scope_id) DO UPDATE SET
        mode = excluded.mode,
        until_at = excluded.until_at,
        wake_keywords_json = excluded.wake_keywords_json,
        revision = chat_presence.revision + 1,
        updated_by_dispatch_event_id = NULL,
        updated_at = excluded.updated_at
    `).run(
      requireText(agentId, "agentId"),
      presence.scope,
      scopeId,
      presence.mode,
      presence.until ?? null,
      JSON.stringify(presence.wakeKeywords),
      timestamp,
      timestamp
    );
    return presence;
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

  public admitChatAttention(
    executionId: string,
    admissions: readonly AdmitChatAttention[],
    at = new Date().toISOString()
  ): readonly ChatDispatchEvent[] {
    const timestamp = iso(at);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const execution = this.#requireExecution(executionId);
      if (execution.handler !== "chat" || execution.status !== "running") {
        throw new Error(`ChatHandler execution is not running: ${executionId}`);
      }
      const sourceEvent = this.#requireEvent(execution.eventId);
      if (sourceEvent.type !== "chat.message") {
        throw new Error(`ChatHandler requires chat.message: ${sourceEvent.eventId}`);
      }
      const source = sourceEvent;
      const dispatches: ChatDispatchEvent[] = [];
      const attentionReceipts = this.chatAttentionReceipts(source.eventId);
      for (const admission of admissions) {
        const promptResourceId = admission.promptResourceId ?? chatPromptResourceId;
        const existing = attentionReceipts.find(
          (receipt) => receipt.agentId === admission.plan.agentId
        );
        if (existing !== undefined) {
          if (existing.dispatchEventId !== undefined) {
            const event = this.#requireEvent(existing.dispatchEventId);
            if (event.type !== "chat.dispatch") {
              throw new Error(
                `Attention receipt dispatch is malformed: ${existing.dispatchEventId}`
              );
            }
            dispatches.push(event);
          }
          continue;
        }
        if (admission.plan.outcome === "skip") {
          attentionReceipts.push(chatAttentionReceipt(
            source.eventId,
            admission.plan,
            undefined,
            undefined,
            timestamp
          ));
          continue;
        }
        if (admission.prompt === undefined) {
          throw new Error("admission.prompt must be non-empty");
        }
        const prompt = requireText(admission.prompt, "admission.prompt");
        const dispatchEventId = newEventId();
        const dispatchExecutionId = runtimeId("exe");
        const current = this.currentLocalAgentSession(admission.plan.agentId);
        const payload = {
          topicId: source.topicId,
          sourceMessageEventId: source.eventId,
          targetHandleSnapshot: admission.plan.handle,
          promptResourceId
        };
        this.#database.prepare(`
          INSERT INTO events (
            event_id, type, source_kind, source_external_id, agent_id, prompt,
            outcome, output, error, payload_json, session_id, destination_ids_json,
            destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
            created_at
          ) VALUES (?, 'chat.dispatch', 'handler', ?, ?, ?, NULL, NULL, NULL, ?, ?, '[]', '[]',
            ?, ?, ?, ?)
        `).run(
          dispatchEventId,
          `chat-attention:${source.eventId}:${admission.plan.agentId}`,
          admission.plan.agentId,
          prompt,
          JSON.stringify(payload),
          current?.sessionId ?? null,
          source.causality.rootEventId,
          source.eventId,
          source.causality.hop + 1,
          timestamp
        );
        this.#database.prepare(`
          INSERT INTO executions (
            execution_id, event_id, handler, status, attempt_count, max_attempts,
            next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, 'agent', 'queued', 0, 3, ?, ?, ?)
        `).run(dispatchExecutionId, dispatchEventId, timestamp, timestamp, timestamp);
        attentionReceipts.push(chatAttentionReceipt(
          source.eventId,
          admission.plan,
          dispatchEventId,
          promptResourceId,
          timestamp
        ));
        const dispatch = this.#requireEvent(dispatchEventId);
        if (dispatch.type !== "chat.dispatch") {
          throw new Error(`Created Event is not chat.dispatch: ${dispatchEventId}`);
        }
        dispatches.push(dispatch);
      }
      this.#database.prepare(`
        UPDATE executions SET status = 'succeeded', completed_at = ?, updated_at = ?,
          last_error = NULL, receipt_json = ?
        WHERE execution_id = ?
      `).run(
        timestamp,
        timestamp,
        JSON.stringify({
          schema: "ChatAttentionReceiptList@1",
          receipts: attentionReceipts
        }),
        executionId
      );
      this.#database.exec("COMMIT");
      return dispatches;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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
    const chat = event.type === "chat.message"
      ? {
          attentionReceipts: this.chatAttentionReceipts(event.eventId)
        }
      : event.type === "chat.dispatch"
        ? {
            promptResourceId: event.promptResourceId,
            attentionReceipts: this.chatAttentionReceipts(event.sourceMessageEventId)
              .filter((receipt) => receipt.dispatchEventId === event.eventId),
            ...(this.chatDecisionReceipt(event.eventId) === undefined
              ? {}
              : { decisionReceipt: this.chatDecisionReceipt(event.eventId)! })
          }
        : undefined;
    return {
      event,
      ...(execution === undefined ? {} : { execution }),
      ...(resultEvent === undefined ? {} : { resultEvent }),
      ...(resultExecution === undefined ? {} : { resultExecution }),
      ...(session === undefined ? {} : { session }),
      deliveries,
      ...(chat === undefined ? {} : { chat })
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
      if (!isAgentInputEvent(event)) {
        throw new Error(`AgentHandler cannot complete ${event.type}: ${event.eventId}`);
      }
      if (event.type !== "chat.dispatch" && receipt.output === undefined) {
        throw new Error(`Agent outcome must include a message: ${event.eventId}`);
      }
      if (event.type === "chat.dispatch" && receipt.chatDecision === undefined) {
        throw new Error(`Chat Agent outcome must include ChatDecision@1: ${event.eventId}`);
      }
      if (event.type !== "chat.dispatch" && receipt.chatDecision !== undefined) {
        throw new Error(`ChatDecision is only valid for chat.dispatch: ${event.eventId}`);
      }
      if (event.type === "chat.dispatch" && receipt.chatDecision !== undefined) {
        const expectedSchema = event.promptResourceId === chatMentionPromptResourceId
          ? "ChatMentionDecision@1"
          : "ChatDecision@1";
        if (receipt.chatDecision.schema !== expectedSchema) {
          throw new Error(
            `Chat Agent outcome must use ${expectedSchema} for ${event.promptResourceId}`
          );
        }
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
        this.#database.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?")
          .run(timestamp, session.sessionId);
      }
      this.#database.prepare(`
        UPDATE executions SET status = 'succeeded', completed_at = ?, updated_at = ?, last_error = NULL
        WHERE execution_id = ?
      `).run(timestamp, timestamp, executionId);
      if (event.type === "chat.dispatch") {
        this.#database.prepare(`
          UPDATE agents
          SET current_session_id = ?, updated_at = ?
          WHERE principal_id = ?
        `).run(session.sessionId, timestamp, event.agentId);
        const decision = receipt.chatDecision!;
        if ("presence" in decision) {
          this.#applyChatPresence(event, decision.presence, timestamp);
        }
        const reply = decision.speech.action === "reply"
          ? this.#createChatReply(event, session.sessionId, decision.speech.body, timestamp)
          : undefined;
        this.#database.prepare(`
          UPDATE executions SET receipt_json = ? WHERE execution_id = ?
        `).run(JSON.stringify({
          schema: "ChatDecisionReceipt@1",
          dispatchEventId: event.eventId,
          speechAction: decision.speech.action,
          ...("presence" in decision
            ? { presenceTransition: decision.presence }
            : {}),
          ...(reply === undefined ? {} : { replyEventId: reply.eventId }),
          createdAt: timestamp
        }), executionId);
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
      for (const destination of this.#destinationSnapshots(resultEvent.eventId)) {
        const maxAttempts = destination.kind === "macos-notification" ? 1 : 5;
        this.#database.prepare(`
          INSERT INTO deliveries (
            delivery_id, result_event_id, destination_id, destination_kind,
            destination_address_json, status, attempt_count, max_attempts,
            next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
          ON CONFLICT(result_event_id, destination_id) DO NOTHING
        `).run(
          runtimeId("del"),
          resultEvent.eventId,
          destination.destinationId,
          destination.kind,
          JSON.stringify(destination.address),
          maxAttempts,
          timestamp,
          timestamp,
          timestamp
        );
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
    const row = this.#database.prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  public sessionForProvider(
    adapterId: string,
    providerSessionId: string
  ): RuntimeSession | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_sessions WHERE adapter_id = ? AND provider_session_id = ?
    `).get(
      requireText(adapterId, "adapterId"),
      requireText(providerSessionId, "providerSessionId")
    ) as SessionRow | undefined;
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
    const existing = this.destination(destinationId);
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
    for (const snapshot of this.#allEventDestinationSnapshots()) {
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
    for (const destination of this.#allEventDestinationSnapshots()) {
      if (!destinations.has(destination.destinationId)) {
        destinations.set(destination.destinationId, destination);
      }
    }
    const deliveryRows = this.#database.prepare(`
      SELECT destination_id, destination_kind AS kind,
        destination_address_json AS address_json,
        MIN(created_at) AS created_at, MAX(updated_at) AS updated_at
      FROM deliveries
      GROUP BY destination_id, destination_kind, destination_address_json
      ORDER BY updated_at DESC, destination_id DESC
    `).all() as unknown as DestinationRow[];
    for (const row of deliveryRows) {
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

  public claimDueDeliveries(
    limit = 100,
    now = new Date().toISOString()
  ): RuntimeDelivery[] {
    const timestamp = iso(now);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#database.prepare(`
        SELECT delivery_id FROM deliveries
        WHERE status IN ('pending', 'retry_wait')
          AND attempt_count < max_attempts
          AND julianday(next_attempt_at) <= julianday(?)
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

  public reconcileInterrupted(at = new Date().toISOString()): number {
    const timestamp = iso(at);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const executions = this.#database.prepare(`
        UPDATE executions SET status = 'retry_wait', next_attempt_at = ?,
          last_error = 'runtime_interrupted', started_at = NULL, updated_at = ?
        WHERE status = 'running'
      `).run(timestamp, timestamp).changes;
      const exhaustedDeliveries = this.#database.prepare(`
        UPDATE deliveries SET status = 'failed', next_attempt_at = ?,
          last_error = 'runtime_interrupted', updated_at = ?
        WHERE status = 'delivering' AND attempt_count >= max_attempts
      `).run(timestamp, timestamp).changes;
      const retryableDeliveries = this.#database.prepare(`
        UPDATE deliveries SET status = 'retry_wait', next_attempt_at = ?,
          last_error = 'runtime_interrupted', updated_at = ?
        WHERE status = 'delivering' AND attempt_count < max_attempts
      `).run(timestamp, timestamp).changes;
      this.#database.exec("COMMIT");
      return Number(executions) + Number(exhaustedDeliveries) +
        Number(retryableDeliveries);
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
      INSERT INTO agent_sessions (
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
        destination_snapshots_json,
        root_event_id, parent_event_id, causal_hop, created_at
      ) VALUES (?, 'agent.result', 'handler', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.execution.executionId,
      input.event.agentId,
      input.outcome,
      input.output ?? null,
      input.error ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.event.destinationIds),
      JSON.stringify(this.#destinationSnapshots(input.event.eventId)),
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
        destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
        created_at
      ) VALUES (?, 'chat.message', 'handler', ?, ?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]',
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
    this.#database.prepare(`
      INSERT INTO executions (
        execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'chat', 'queued', 0, 3, ?, ?, ?)
    `).run(runtimeId("exe"), eventId, at, at, at);
    const event = this.#requireEvent(eventId);
    if (event.type !== "chat.message") throw new Error(`Event is not chat.message: ${eventId}`);
    return event;
  }

  #applyChatPresence(
    dispatch: ChatDispatchEvent,
    presence: ChatPresence,
    at: string
  ): void {
    const scopeId = presence.scope === "global" ? "*" : dispatch.topicId;
    this.#database.prepare(`
      INSERT INTO chat_presence (
        agent_id, scope_kind, scope_id, mode, until_at, wake_keywords_json,
        revision, updated_by_dispatch_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(agent_id, scope_kind, scope_id) DO UPDATE SET
        mode = excluded.mode,
        until_at = excluded.until_at,
        wake_keywords_json = excluded.wake_keywords_json,
        revision = chat_presence.revision + 1,
        updated_by_dispatch_event_id = excluded.updated_by_dispatch_event_id,
        updated_at = excluded.updated_at
    `).run(
      dispatch.agentId,
      presence.scope,
      scopeId,
      presence.mode,
      presence.until ?? null,
      JSON.stringify(presence.wakeKeywords),
      dispatch.eventId,
      at,
      at
    );
  }

  #destinationSnapshots(eventId: string): readonly DestinationSnapshot[] {
    const row = this.#database.prepare(`
      SELECT destination_snapshots_json FROM events WHERE event_id = ?
    `).get(eventId) as { destination_snapshots_json: string } | undefined;
    if (row === undefined) throw new Error(`Event not found: ${eventId}`);
    return parseDestinationSnapshots(row.destination_snapshots_json, eventId);
  }

  #allEventDestinationSnapshots(): readonly DestinationSnapshot[] {
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
  if (input.reviewInvocation !== undefined) {
    validateReviewInvocation(input.reviewInvocation, input.agentId);
  }
  if (input.source.externalId !== undefined) requireText(input.source.externalId, "source.externalId");
  if (input.parent !== undefined) bounded(input.parent.hop, 0, 1_000, "parent.hop");
}

function validateAddress(address: Readonly<Record<string, string>>): void {
  const entries = Object.entries(address);
  if (entries.length === 0) throw new Error("Destination address must not be empty");
  if (entries.length > 32) throw new Error("Destination address must contain at most 32 fields");
  for (const [key, value] of entries) {
    requireText(key, "Destination address key");
    requireText(value, `Destination address ${key}`);
    if (key.length > 128) throw new Error("Destination address key is too long");
    if (value.length > 4_096) {
      throw new Error(`Destination address ${key} exceeds 4096 characters`);
    }
  }
}

function chatAttentionReceipt(
  sourceMessageEventId: string,
  plan: ChatAttentionPlan,
  dispatchEventId: string | undefined,
  promptResourceId: string | undefined,
  at: string
): ChatAttentionReceipt {
  return {
    sourceMessageEventId,
    agentId: plan.agentId,
    outcome: plan.outcome === "dispatch" ? "dispatched" : "skipped",
    reason: plan.reason,
    presenceSnapshot: plan.presenceSnapshot,
    ...(dispatchEventId === undefined ? {} : { dispatchEventId }),
    ...(promptResourceId === undefined ? {} : { promptResourceId }),
    createdAt: at
  };
}

function parseChatAttentionReceiptList(value: string | null): ChatAttentionReceipt[] {
  if (value === null) return [];
  const parsed = parseJsonObject(value, "Execution receipt");
  if (parsed.schema !== "ChatAttentionReceiptList@1" ||
    !Array.isArray(parsed.receipts)) {
    return [];
  }
  return parsed.receipts.map((entry, index) => {
    if (!isRecord(entry) ||
      typeof entry.sourceMessageEventId !== "string" ||
      typeof entry.agentId !== "string" ||
      (entry.outcome !== "dispatched" && entry.outcome !== "skipped") ||
      typeof entry.reason !== "string" ||
      !isRecord(entry.presenceSnapshot) ||
      typeof entry.createdAt !== "string") {
      throw new Error(`Chat attention receipt ${index} is malformed`);
    }
    return {
      sourceMessageEventId: entry.sourceMessageEventId,
      agentId: entry.agentId,
      outcome: entry.outcome,
      reason: entry.reason as ChatAttentionReason,
      presenceSnapshot: entry.presenceSnapshot as ChatAttentionPlan["presenceSnapshot"],
      ...(typeof entry.dispatchEventId === "string"
        ? { dispatchEventId: entry.dispatchEventId }
        : {}),
      ...(typeof entry.promptResourceId === "string"
        ? { promptResourceId: entry.promptResourceId }
        : {}),
      createdAt: entry.createdAt
    };
  });
}

function parseChatDecisionReceipt(value: string | null): ChatDecisionReceipt | undefined {
  if (value === null) return undefined;
  const parsed = parseJsonObject(value, "Execution receipt");
  if (parsed.schema !== "ChatDecisionReceipt@1") return undefined;
  if (typeof parsed.dispatchEventId !== "string" ||
    (parsed.speechAction !== "reply" && parsed.speechAction !== "silent") ||
    typeof parsed.createdAt !== "string") {
    throw new Error("Chat decision receipt is malformed");
  }
  const presence = parsed.presenceTransition === undefined
    ? undefined
    : parseChatPresence(parsed.presenceTransition, parsed.createdAt);
  return {
    dispatchEventId: parsed.dispatchEventId,
    speechAction: parsed.speechAction,
    ...(presence === undefined ? {} : { presenceTransition: presence }),
    ...(typeof parsed.replyEventId === "string"
      ? { replyEventId: parsed.replyEventId }
      : {}),
    createdAt: parsed.createdAt
  };
}

function parseDestinationSnapshots(
  value: string,
  eventId: string
): DestinationSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Event Destination snapshots are malformed: ${eventId}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Event Destination snapshots are malformed: ${eventId}`);
  }
  return parsed.map((entry) => {
    if (!isRecord(entry) ||
      typeof entry.destinationId !== "string" ||
      (entry.kind !== "matrix" && entry.kind !== "macos-notification") ||
      !isStringRecord(entry.address) ||
      typeof entry.createdAt !== "string" ||
      typeof entry.updatedAt !== "string") {
      throw new Error(`Event Destination snapshot is malformed: ${eventId}`);
    }
    return {
      destinationId: entry.destinationId,
      kind: entry.kind,
      address: entry.address,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  });
}

function parseJsonObject(value: string, field: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${field} must be a JSON object`);
  return parsed;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
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
