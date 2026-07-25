import type { DatabaseSync } from "node:sqlite";

import {
  newEventId,
  type Event,
  type ChatDispatchEvent,
  type ChatMessageEvent
} from "../../core/event/model.js";
import { chatPromptResourceId } from "../../core/chat/model.js";
import { runtimeId } from "../../core/runtime/model.js";
import { openRuntimeDatabase } from "./database.js";

export interface ChatAgentChoice {
  readonly principalId: string;
  readonly handle: string;
}

export interface ChatMessageAdmission {
  readonly message: ChatMessageEvent;
  readonly dispatch?: {
    readonly event: ChatDispatchEvent;
    readonly executionId: string;
    readonly status: "accepted" | "duplicate";
  };
}

export interface ChatMessagePage {
  readonly items: readonly ChatMessageEvent[];
  readonly hasEarlier: boolean;
  readonly beforeEventId?: string;
}

export class LocalChatStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = openRuntimeDatabase(databasePath);
  }

  public close(): void {
    this.#database.close();
  }

  public postOwnerMessage(input: {
    readonly topicId: string;
    readonly ownerPrincipalId: string;
    readonly body: string;
    readonly target?: ChatAgentChoice;
    readonly at?: string;
  }): ChatMessageAdmission {
    const body = requireBody(input.body);
    const at = timestamp(input.at);
    const messageId = newEventId();
    const payload = {
      topicId: requireText(input.topicId, "topicId"),
      sender: {
        kind: "owner",
        principalId: requireText(input.ownerPrincipalId, "ownerPrincipalId"),
        handleSnapshot: "owner"
      },
      body,
      ...(input.target === undefined
        ? {}
        : {
            target: {
              principalId: requireText(input.target.principalId, "target.principalId"),
              handleSnapshot: requireText(input.target.handle, "target.handle")
            }
          })
    };
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#insertChatMessage(messageId, payload, at);
      this.#database.exec("COMMIT");
      return { message: this.#requireChatMessage(messageId) };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public dispatch(input: {
    readonly sourceMessageEventId: string;
    readonly topicId: string;
    readonly target: ChatAgentChoice;
    readonly at?: string;
  }): NonNullable<ChatMessageAdmission["dispatch"]> {
    const at = timestamp(input.at);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#existingDispatch(input.sourceMessageEventId);
      if (existing !== undefined) {
        this.#database.exec("COMMIT");
        return { ...existing, status: "duplicate" };
      }
      const source = this.#requireChatMessage(input.sourceMessageEventId);
      if (source.topicId !== input.topicId || source.sender.kind !== "owner") {
        throw new Error("dispatch source must be an Owner message in Local Chat");
      }
      const receipt = this.#insertDispatch(
        source.eventId,
        source.topicId,
        source.body,
        input.target,
        source.causality.rootEventId,
        source.causality.hop,
        at
      );
      this.#database.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public dispatchReceipt(
    sourceMessageEventId: string
  ): NonNullable<ChatMessageAdmission["dispatch"]> | undefined {
    const existing = this.#existingDispatch(sourceMessageEventId);
    return existing === undefined ? undefined : { ...existing, status: "duplicate" };
  }

  public promptPending(
    topicId: string,
    candidates: readonly ChatAgentChoice[],
    at = new Date().toISOString()
  ): readonly ChatMessageEvent[] {
    const pending = this.#database.prepare(`
      SELECT e.event_id
      FROM events e
      WHERE e.type = 'chat.message'
        AND json_extract(e.payload_json, '$.topicId') = ?
        AND json_extract(e.payload_json, '$.sender.kind') = 'owner'
        AND json_type(e.payload_json, '$.target') IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM events dispatch
          WHERE dispatch.type = 'chat.dispatch'
            AND json_extract(dispatch.payload_json, '$.sourceMessageEventId') = e.event_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM events prompt
          WHERE prompt.type = 'chat.message'
            AND json_extract(
              prompt.payload_json,
              '$.dispatchCard.sourceMessageEventId'
            ) = e.event_id
        )
      ORDER BY e.created_at, e.event_id
      LIMIT 100
    `).all(topicId) as unknown as Array<{ event_id: string }>;
    const created: ChatMessageEvent[] = [];
    for (const row of pending) {
      const promptId = newEventId();
      const payload = {
        topicId,
        sender: {
          kind: "system",
          handleSnapshot: "system"
        },
        body: "Who should receive this message?",
        dispatchCard: {
          sourceMessageEventId: row.event_id,
          candidates: candidates.map(({ principalId, handle }) => ({ principalId, handle }))
        }
      };
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#insertChatMessage(
          promptId,
          payload,
          timestamp(at),
          row.event_id,
          `local-chat-prompt:${row.event_id}`
        );
        created.push(this.#requireChatMessage(promptId));
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        if (!isUniqueConstraint(error)) throw error;
      }
    }
    return created;
  }

  public events(topicId: string, limit = 200): readonly Event[] {
    const rows = this.#database.prepare(`
      SELECT event_id FROM events
      WHERE type IN ('chat.message', 'chat.dispatch')
        AND json_extract(payload_json, '$.topicId') = ?
      ORDER BY created_at ASC, event_id ASC
      LIMIT ?
    `).all(topicId, bounded(limit, 1, 1_000)) as unknown as Array<{ event_id: string }>;
    return rows.map(({ event_id }) => this.#requireChatEvent(event_id));
  }

  public messagePage(
    topicIdInput: string,
    options: {
      readonly beforeEventId?: string;
      readonly limit?: number;
    } = {}
  ): ChatMessagePage {
    const topicId = requireText(topicIdInput, "topicId");
    const limit = bounded(options.limit ?? 50, 1, 200);
    const before = options.beforeEventId === undefined
      ? undefined
      : this.#database.prepare(`
          SELECT event_id, created_at
          FROM events
          WHERE event_id = ?
            AND type = 'chat.message'
            AND json_extract(payload_json, '$.topicId') = ?
        `).get(options.beforeEventId, topicId) as {
          event_id: string;
          created_at: string;
        } | undefined;
    if (options.beforeEventId !== undefined && before === undefined) {
      throw new Error(`Chat history cursor is not a message in Topic: ${options.beforeEventId}`);
    }
    const rows = this.#database.prepare(`
      SELECT event_id
      FROM events
      WHERE type = 'chat.message'
        AND json_extract(payload_json, '$.topicId') = ?
        ${before === undefined
          ? ""
          : "AND (created_at < ? OR (created_at = ? AND event_id < ?))"}
      ORDER BY created_at DESC, event_id DESC
      LIMIT ?
    `).all(
      topicId,
      ...(before === undefined
        ? []
        : [before.created_at, before.created_at, before.event_id]),
      limit + 1
    ) as unknown as Array<{ event_id: string }>;
    const hasEarlier = rows.length > limit;
    const items = rows.slice(0, limit)
      .map(({ event_id }) => this.#requireChatMessage(event_id))
      .reverse();
    return {
      items,
      hasEarlier,
      ...(hasEarlier && items[0] !== undefined
        ? { beforeEventId: items[0].eventId }
        : {})
    };
  }

  public newSession(principalId: string, at = new Date().toISOString()): number {
    this.#database.prepare(`
      UPDATE agents
      SET current_session_id = NULL,
        session_generation = session_generation + 1,
        updated_at = ?
      WHERE principal_id = ?
    `).run(timestamp(at), principalId);
    return (this.#database.prepare(`
      SELECT session_generation FROM agents WHERE principal_id = ?
    `).get(principalId) as { session_generation: number }).session_generation;
  }

  public currentSession(principalId: string): {
    readonly sessionId?: string;
    readonly generation: number;
  } {
    const row = this.#database.prepare(`
      SELECT current_session_id, session_generation
      FROM agents WHERE principal_id = ?
    `).get(principalId) as {
      current_session_id: string | null;
      session_generation: number;
    } | undefined;
    return row === undefined
      ? { generation: 1 }
      : {
          generation: row.session_generation,
          ...(row.current_session_id === null ? {} : { sessionId: row.current_session_id })
        };
  }

  public currentAgentSession(principalId: string): {
    readonly sessionId: string;
    readonly generation: number;
    readonly state: "created" | "resumed";
    readonly updatedAt: string;
  } | undefined {
    const current = this.currentSession(principalId);
    if (current.sessionId === undefined) return undefined;
    const row = this.#database.prepare(`
      SELECT created_at, updated_at
      FROM agent_sessions WHERE session_id = ?
    `).get(current.sessionId) as {
      created_at: string;
      updated_at: string;
    } | undefined;
    if (row === undefined) {
      return {
        sessionId: current.sessionId,
        generation: current.generation,
        state: "created",
        updatedAt: new Date().toISOString()
      };
    }
    return {
      sessionId: current.sessionId,
      generation: current.generation,
      state: row.updated_at > row.created_at ? "resumed" : "created",
      updatedAt: row.updated_at
    };
  }

  #insertChatMessage(
    eventId: string,
    payload: Readonly<Record<string, unknown>>,
    at: string,
    parentEventId?: string,
    sourceExternalId?: string
  ): void {
    this.#database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        destination_snapshots_json,
        root_event_id, parent_event_id, causal_hop, created_at
      ) VALUES (?, 'chat.message', ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, '[]', '[]',
        ?, ?, ?, ?)
    `).run(
      eventId,
      (payload.sender as { kind: string }).kind === "owner" ? "cli" : "handler",
      sourceExternalId ?? null,
      (payload.sender as { principalId?: string }).principalId ?? null,
      JSON.stringify(payload),
      parentEventId ?? eventId,
      parentEventId ?? null,
      parentEventId === undefined ? 0 : 1,
      at
    );
    if ((payload.sender as { kind: string }).kind !== "system") {
      this.#database.prepare(`
        INSERT INTO executions (
          execution_id, event_id, handler, status, attempt_count, max_attempts,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, 'chat', 'queued', 0, 3, ?, ?, ?)
      `).run(runtimeId("exe"), eventId, at, at, at);
    }
  }

  #insertDispatch(
    sourceMessageEventId: string,
    topicId: string,
    prompt: string,
    target: ChatAgentChoice,
    rootEventId: string,
    parentHop: number,
    at: string
  ): NonNullable<ChatMessageAdmission["dispatch"]> {
    const existing = this.#existingDispatch(sourceMessageEventId);
    if (existing !== undefined) return { ...existing, status: "duplicate" };
    const eventId = newEventId();
    const executionId = runtimeId("exe");
    const current = this.currentSession(target.principalId);
    const payload = {
      topicId,
      sourceMessageEventId,
      targetHandleSnapshot: target.handle,
      promptResourceId: chatPromptResourceId
    };
    this.#database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        destination_snapshots_json,
        root_event_id, parent_event_id, causal_hop, created_at
      ) VALUES (?, 'chat.dispatch', 'handler', ?, ?, ?, NULL, NULL, NULL, ?, ?, '[]', '[]',
        ?, ?, ?, ?)
    `).run(
      eventId,
      `local-chat-dispatch:${sourceMessageEventId}`,
      target.principalId,
      prompt,
      JSON.stringify(payload),
      current.sessionId ?? null,
      rootEventId,
      sourceMessageEventId,
      parentHop + 1,
      at
    );
    this.#database.prepare(`
      INSERT INTO executions (
        execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'agent', 'queued', 0, 3, ?, ?, ?)
    `).run(executionId, eventId, at, at, at);
    return {
      event: this.#requireChatDispatch(eventId),
      executionId,
      status: "accepted"
    };
  }

  #existingDispatch(sourceMessageEventId: string): {
    readonly event: ChatDispatchEvent;
    readonly executionId: string;
  } | undefined {
    const row = this.#database.prepare(`
      SELECT event.event_id AS dispatch_event_id, execution.execution_id
      FROM events AS event
      JOIN executions AS execution ON execution.event_id = event.event_id
      WHERE event.type = 'chat.dispatch'
        AND json_extract(event.payload_json, '$.sourceMessageEventId') = ?
      ORDER BY event.created_at, event.event_id
      LIMIT 1
    `).get(sourceMessageEventId) as {
      dispatch_event_id: string;
      execution_id: string;
    } | undefined;
    return row === undefined
      ? undefined
      : {
          event: this.#requireChatDispatch(row.dispatch_event_id),
          executionId: row.execution_id
        };
  }

  #requireChatMessage(eventId: string): ChatMessageEvent {
    const event = this.#requireChatEvent(eventId);
    if (event.type !== "chat.message") throw new Error(`Chat message not found: ${eventId}`);
    return event;
  }

  #requireChatDispatch(eventId: string): ChatDispatchEvent {
    const event = this.#requireChatEvent(eventId);
    if (event.type !== "chat.dispatch") throw new Error(`Chat dispatch not found: ${eventId}`);
    return event;
  }

  #requireChatEvent(eventId: string): ChatMessageEvent | ChatDispatchEvent {
    const row = this.#database.prepare(`
      SELECT event_id, type, source_kind, source_external_id, agent_id, prompt,
             payload_json, session_id, root_event_id, parent_event_id, causal_hop, created_at
      FROM events WHERE event_id = ?
    `).get(eventId) as {
      event_id: string;
      type: "chat.message" | "chat.dispatch";
      source_kind: Event["source"]["kind"];
      source_external_id: string | null;
      agent_id: string | null;
      prompt: string | null;
      payload_json: string | null;
      session_id: string | null;
      root_event_id: string;
      parent_event_id: string | null;
      causal_hop: number;
      created_at: string;
    } | undefined;
    if (row === undefined || row.payload_json === null ||
      (row.type !== "chat.message" && row.type !== "chat.dispatch")) {
      throw new Error(`Chat Event not found: ${eventId}`);
    }
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const common = {
      eventId: row.event_id,
      source: {
        kind: row.source_kind,
        ...(row.source_external_id === null ? {} : { externalId: row.source_external_id })
      },
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      destinationIds: [] as readonly string[],
      causality: {
        rootEventId: row.root_event_id,
        ...(row.parent_event_id === null ? {} : { parentEventId: row.parent_event_id }),
        hop: row.causal_hop
      },
      createdAt: row.created_at
    };
    if (row.type === "chat.dispatch") {
      if (row.agent_id === null || row.prompt === null) {
        throw new Error(`Chat dispatch is incomplete: ${eventId}`);
      }
      return {
        ...common,
        type: "chat.dispatch",
        agentId: row.agent_id,
        topicId: String(payload.topicId),
        sourceMessageEventId: String(payload.sourceMessageEventId),
        targetHandleSnapshot: String(payload.targetHandleSnapshot),
        promptResourceId: typeof payload.promptResourceId === "string"
          ? payload.promptResourceId
          : "prompt.chat.legacy",
        prompt: row.prompt
      };
    }
    const sender = payload.sender as ChatMessageEvent["sender"];
    const target = payload.target as ChatMessageEvent["target"] | undefined;
    const dispatchCard = payload.dispatchCard as ChatMessageEvent["dispatchCard"] | undefined;
    return {
      ...common,
      type: "chat.message",
      ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
      topicId: String(payload.topicId),
      sender,
      body: String(payload.body),
      ...(target === undefined ? {} : { target }),
      ...(dispatchCard === undefined ? {} : { dispatchCard })
    };
  }
}

function requireBody(value: string): string {
  const body = value.trim();
  if (body === "") throw new Error("Chat message body must be non-empty");
  if (body.length > 65_536) throw new Error("Chat message body exceeds 65536 characters");
  return body;
}

function requireText(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function timestamp(value = new Date().toISOString()): string {
  if (Number.isNaN(Date.parse(value))) throw new Error("timestamp must be ISO-8601");
  return new Date(value).toISOString();
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`limit must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
