import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "../../../infrastructure/sqlite/transaction.js";
import {
  chatPromptResourceId,
  parseConversationIntentSnapshot,
  parseChatPresence,
  type ChatPresence
} from "../../chat/model.js";
import {
  newEventId,
  requireEventId,
  type ChatDispatchEvent,
  type ChatMessageEvent,
  type ChatRunProposalDecision
} from "../../event/model.js";
import { runtimeId, type RuntimeExecution } from "../model.js";
import {
  bounded,
  chatAttentionReceipt,
  iso,
  requireText
} from "./codec.js";
import { RuntimeStoreQuery } from "./query.js";
import type {
  AdmitChatAttention,
  AppendRuntimeEventReceipt,
  CreateChatActivation
} from "./types.js";

export class RuntimeChatStore {
  readonly #database: DatabaseSync;
  readonly #query: RuntimeStoreQuery;

  public constructor(database: DatabaseSync, query: RuntimeStoreQuery) {
    this.#database = database;
    this.#query = query;
  }

  public setPresence(
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

  public createActivation(
    input: CreateChatActivation,
    at = new Date().toISOString()
  ): AppendRuntimeEventReceipt {
    return withImmediateTransaction(
      this.#database,
      () => this.createActivationInTransaction(input, at)
    );
  }

  public createActivationInTransaction(
    input: CreateChatActivation,
    at = new Date().toISOString()
  ): AppendRuntimeEventReceipt {
    const timestamp = iso(at);
    const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
      if (idempotencyKey.length > 512) throw new Error("idempotencyKey is too long");
      const externalId = `chat-activation:${idempotencyKey}`;
      const existing = this.#database.prepare(`
        SELECT event_id FROM events
        WHERE source_kind = 'handler' AND source_external_id = ?
      `).get(externalId) as { event_id: string } | undefined;
      if (existing !== undefined) {
        const event = this.#query.event(existing.event_id);
        const execution = event === undefined
          ? undefined
          : this.#query.executionForEvent(event.eventId);
        if (event?.type !== "chat.activation" || execution === undefined) {
          throw new Error(`Chat activation idempotency collision: ${input.idempotencyKey}`);
        }
        return { event, execution, status: "duplicate" };
      }
      const topicId = requireText(input.topicId, "topicId");
      const activeRoot = this.#database.prepare(`
        SELECT root.event_id
        FROM events AS root
        WHERE root.type = 'chat.activation'
          AND json_extract(root.payload_json, '$.topicId') = ?
          AND EXISTS (
            SELECT 1
            FROM events AS member
            JOIN executions AS execution ON execution.event_id = member.event_id
            WHERE member.root_event_id = root.event_id
              AND execution.status IN ('queued', 'running', 'retry_wait')
          )
        ORDER BY root.created_at DESC, root.event_id DESC
        LIMIT 1
      `).get(topicId) as { event_id: string } | undefined;
      if (activeRoot !== undefined) {
        const event = this.#query.event(activeRoot.event_id);
        const execution = event === undefined
          ? undefined
          : this.#query.executionForEvent(event.eventId);
        if (event?.type !== "chat.activation" || execution === undefined) {
          throw new Error(`Active Chat activation is malformed: ${activeRoot.event_id}`);
        }
        return { event, execution, status: "duplicate" };
      }
      const eventId = newEventId();
      const executionId = runtimeId("exe");
      const turnBudget = input.turnBudget ?? 8;
      if (!Number.isInteger(turnBudget) || turnBudget < 1 || turnBudget > 64) {
        throw new Error("turnBudget must be an integer between 1 and 64");
      }
      const expiresAt = iso(input.expiresAt ??
        new Date(Date.parse(timestamp) + 15 * 60_000).toISOString());
      if (Date.parse(expiresAt) <= Date.parse(timestamp)) {
        throw new Error("expiresAt must be in the future");
      }
      const uniqueCandidateAgentIds = [...new Set(input.candidateAgentIds.map((candidate) =>
        requireText(candidate, "candidateAgentId")))];
      const candidateAgentIds = input.sequentialDispatch === true
        ? uniqueCandidateAgentIds
        : uniqueCandidateAgentIds.sort();
      if (candidateAgentIds.length === 0 || candidateAgentIds.length > 64) {
        throw new Error("candidateAgentIds must contain between 1 and 64 Agents");
      }
      const strategyRevision = bounded(
        input.strategyRevision ?? 1, 1, 1_000_000, "strategyRevision"
      );
      const contextRevision = bounded(
        input.contextRevision ?? 1, 1, 1_000_000, "contextRevision"
      );
      const payload = {
        topicId,
        reason: input.reason,
        strategyId: input.strategyId,
        conversationIntent: parseConversationIntentSnapshot(input.conversationIntent),
        strategyRevision,
        contextRevision,
        candidateAgentIds,
        ...(input.sequentialDispatch === true ? { sequentialDispatch: true } : {}),
        ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
        turnBudget,
        expiresAt
      };
      this.#database.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, source_external_id, agent_id, prompt,
          outcome, output, error, payload_json, session_id, destination_ids_json,
          destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
          created_at
        ) VALUES (?, 'chat.activation', 'handler', ?, NULL, NULL, NULL, NULL, NULL,
          ?, NULL, '[]', '[]', ?, NULL, 0, ?)
      `).run(eventId, externalId, JSON.stringify(payload), eventId, timestamp);
      this.#database.prepare(`
        INSERT INTO executions (
          execution_id, event_id, handler, status, attempt_count, max_attempts,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, 'chat', 'queued', 0, 3, ?, ?, ?)
      `).run(executionId, eventId, timestamp, timestamp, timestamp);
      const event = this.#query.event(eventId);
      const execution = this.#query.execution(executionId);
      if (event?.type !== "chat.activation" || execution === undefined) {
        throw new Error(`Created chat activation is malformed: ${eventId}`);
      }
    return { event, execution, status: "accepted" };
  }

  public admitAttention(
    executionId: string,
    admissions: readonly AdmitChatAttention[],
    at = new Date().toISOString()
  ): readonly ChatDispatchEvent[] {
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => {
      const execution = this.#requireExecution(executionId);
      if (execution.handler !== "chat" || execution.status !== "running") {
        throw new Error(`ChatHandler execution is not running: ${executionId}`);
      }
      const sourceEvent = this.#query.event(execution.eventId);
      if (sourceEvent === undefined) throw new Error(`Event not found: ${execution.eventId}`);
      if (sourceEvent.type !== "chat.message" && sourceEvent.type !== "chat.activation") {
        throw new Error(`ChatHandler requires chat attention source: ${sourceEvent.eventId}`);
      }
      const source = sourceEvent;
      const root = this.#query.event(source.causality.rootEventId);
      const turnBudget = root?.type === "chat.activation"
        ? root.turnBudget
        : root?.type === "chat.message" && root.conversation !== undefined
          ? root.conversation.turnBudget
        : Number.POSITIVE_INFINITY;
      let dispatchedTurns = (this.#database.prepare(`
        SELECT COUNT(*) AS count FROM events
        WHERE root_event_id = ? AND type = 'chat.dispatch'
      `).get(source.causality.rootEventId) as { count: number }).count;
      const dispatches: ChatDispatchEvent[] = [];
      const attentionReceipts = this.#query.chatAttentionReceipts(source.eventId);
      for (const admission of admissions) {
        const promptResourceId = admission.promptResourceId ?? chatPromptResourceId;
        const existing = attentionReceipts.find(
          (receipt) => receipt.agentId === admission.plan.agentId
        );
        if (existing !== undefined) {
          if (existing.dispatchEventId !== undefined) {
            const event = this.#query.event(existing.dispatchEventId);
            if (event?.type !== "chat.dispatch") {
              throw new Error(`Attention receipt dispatch is malformed: ${existing.dispatchEventId}`);
            }
            dispatches.push(event);
          }
          continue;
        }
        const plan = admission.plan.outcome === "dispatch" &&
          dispatchedTurns >= turnBudget
          ? { ...admission.plan, outcome: "skip" as const, reason: "turn-budget-exhausted" as const }
          : admission.plan;
        if (plan.outcome === "skip") {
          attentionReceipts.push(chatAttentionReceipt(
            source.eventId,
            plan,
            undefined,
            undefined,
            timestamp
          ));
          continue;
        }
        if (admission.prompt === undefined) throw new Error("admission.prompt must be non-empty");
        const prompt = requireText(admission.prompt, "admission.prompt");
        const dispatchEventId = newEventId();
        const dispatchExecutionId = runtimeId("exe");
        const current = this.#query.currentLocalAgentSession(admission.plan.agentId);
        const payload = {
          topicId: source.topicId,
          sourceAttentionEventId: source.eventId,
          ...(source.type === "chat.message"
            ? { sourceMessageEventId: source.eventId }
            : {}),
          targetHandleSnapshot: admission.plan.handle,
          promptResourceId,
          ...(admission.admissionSnapshot === undefined
            ? {}
            : { admissionSnapshot: admission.admissionSnapshot }),
          ...(admission.profileContext === undefined
            ? {}
            : { profileContext: admission.profileContext })
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
        dispatchedTurns += 1;
        attentionReceipts.push(chatAttentionReceipt(
          source.eventId,
          admission.plan,
          dispatchEventId,
          promptResourceId,
          timestamp
        ));
        const dispatch = this.#query.event(dispatchEventId);
        if (dispatch?.type !== "chat.dispatch") {
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
        JSON.stringify({ schema: "ChatAttentionReceiptList@1", receipts: attentionReceipts }),
        executionId
      );
      return dispatches;
    });
  }

  public createReply(
    dispatch: ChatDispatchEvent,
    sessionId: string,
    body: string,
    at: string,
    continueAttention = true
  ): ChatMessageEvent {
    const eventId = newEventId();
    const payload = {
      topicId: dispatch.topicId,
      sender: {
        kind: "agent",
        principalId: dispatch.agentId,
        handleSnapshot: dispatch.targetHandleSnapshot
      },
      body,
      ...(dispatch.sourceMessageEventId === undefined
        ? {}
        : { replyToEventId: dispatch.sourceMessageEventId })
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
    if (continueAttention) {
      this.#database.prepare(`
        INSERT INTO executions (
          execution_id, event_id, handler, status, attempt_count, max_attempts,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, 'chat', 'queued', 0, 3, ?, ?, ?)
      `).run(runtimeId("exe"), eventId, at, at, at);
    }
    const event = this.#query.event(eventId);
    if (event?.type !== "chat.message") throw new Error(`Event is not chat.message: ${eventId}`);
    return event;
  }

  public recordRunProposalDeclinedInTransaction(input: {
    readonly sourceMessageEventId: string;
    readonly dispatchEventId: string;
    readonly actorPrincipalId: string;
  }, at: string): {
    readonly status: "declined" | "duplicate";
    readonly event: ChatMessageEvent;
  } {
    const sourceMessageEventId = requireEventId(
      input.sourceMessageEventId,
      "sourceMessageEventId"
    );
    const dispatchEventId = requireEventId(input.dispatchEventId, "dispatchEventId");
    const actorPrincipalId = requireText(input.actorPrincipalId, "actorPrincipalId");
    const externalId = `chat-run-proposal-decision:${sourceMessageEventId}:${dispatchEventId}`;
    const existing = this.#database.prepare(`
      SELECT event_id FROM events
      WHERE source_kind = 'cli' AND source_external_id = ?
    `).get(externalId) as { event_id: string } | undefined;
    if (existing !== undefined) {
      const event = this.#query.event(existing.event_id);
      if (event?.type !== "chat.message" ||
        event.runProposalDecision?.sourceMessageEventId !== sourceMessageEventId ||
        event.runProposalDecision.dispatchEventId !== dispatchEventId ||
        event.runProposalDecision.action !== "declined" ||
        event.runProposalDecision.actor.principalId !== actorPrincipalId) {
        throw new Error(`Chat Run proposal decision idempotency collision: ${externalId}`);
      }
      return { status: "duplicate", event };
    }
    const source = this.#query.event(sourceMessageEventId);
    if (source?.type !== "chat.message" || source.sender.kind !== "owner") {
      throw new Error("Run proposal source must be an exact Owner message");
    }
    if (source.sender.principalId !== actorPrincipalId) {
      throw new Error("Run proposal decision actor must own the source message");
    }
    const dispatch = this.#query.event(dispatchEventId);
    if (dispatch?.type !== "chat.dispatch" ||
      dispatch.sourceMessageEventId !== sourceMessageEventId ||
      dispatch.topicId !== source.topicId ||
      dispatch.causality.rootEventId !== source.causality.rootEventId) {
      throw new Error("Run proposal decision must target the exact Chat dispatch");
    }
    const decidedAt = iso(at);
    const decision: ChatRunProposalDecision = {
      schema: "ChatRunProposalDecision@1",
      sourceMessageEventId,
      dispatchEventId,
      action: "declined",
      actor: { kind: "owner", principalId: actorPrincipalId },
      decidedAt
    };
    const eventId = newEventId();
    this.#database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
        created_at
      ) VALUES (?, 'chat.message', 'cli', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL,
        '[]', '[]', ?, ?, ?, ?)
    `).run(
      eventId,
      externalId,
      JSON.stringify({
        topicId: source.topicId,
        sender: { kind: "system", handleSnapshot: "System" },
        body: `Owner declined Run proposal from @${dispatch.targetHandleSnapshot}.`,
        replyToEventId: sourceMessageEventId,
        runProposalDecision: decision
      }),
      source.causality.rootEventId,
      dispatchEventId,
      dispatch.causality.hop + 1,
      decidedAt
    );
    const event = this.#query.event(eventId);
    if (event?.type !== "chat.message") {
      throw new Error(`Created Event is not chat.message: ${eventId}`);
    }
    return { status: "declined", event };
  }

  public applyPresence(dispatch: ChatDispatchEvent, presence: ChatPresence, at: string): void {
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

  #requireExecution(executionId: string): RuntimeExecution {
    const execution = this.#query.execution(executionId);
    if (execution === undefined) throw new Error(`Execution not found: ${executionId}`);
    return execution;
  }
}
