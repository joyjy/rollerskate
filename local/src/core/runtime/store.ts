import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openInitializedRuntimeDatabase } from
  "../../infrastructure/sqlite/database.js";
import {
  type ChatAttentionReceipt,
  type ChatDecisionReceipt
} from "../../infrastructure/sqlite/runtime-mappers.js";
import { migrateRuntimeDatabase } from "../../infrastructure/sqlite/runtime-schema.js";
import { withImmediateTransaction as runImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
export type {
  ChatAttentionReceipt,
  ChatDecisionReceipt
} from "../../infrastructure/sqlite/runtime-mappers.js";
import {
  chatMentionPromptResourceId,
  type ChatPresence
} from "../chat/model.js";
import {
  isAgentInputEvent,
  requireEventId,
  type AgentResultEvent,
  type CreateEvent,
  type Event,
  type ChatDispatchEvent,
  type ChatMessageEvent
} from "../event/model.js";
import {
  requireRuntimeId,
  runtimeId,
  type RuntimeExecution,
  type RuntimeDestination,
  type RuntimeDelivery,
  type RuntimeSession
} from "./model.js";
import {
  annealedRetryAt,
  bounded,
  iso,
  normalizeAgentInvocationFailure,
  normalizeAgentInvocationProgress,
  parseAgentInvocationFailureReceipt,
  requireText
} from "./store/codec.js";
import type { AgentInvocationProgress } from "./agent-invocation.js";
import { RuntimeStoreQuery } from "./store/query.js";
import { RuntimeChatStore } from "./store/chat.js";
import { RuntimeDeliveryStore } from "./store/delivery.js";
import { RuntimeEventStore } from "./store/event.js";
import { RuntimeAuditQuery } from "./store/audit.js";
import { notifyRuntimeWork } from "./wake.js";
import type {
  AdmitChatAttention,
  AppendRuntimeEventReceipt,
  CompleteRuntimeExecution,
  CreateChatActivation,
  FailRuntimeExecutionOptions,
  RuntimeAudit,
  RuntimeExecutionOutcome
} from "./store/types.js";

export { annealedRetryAt } from "./store/codec.js";
export type {
  AdmitChatAttention,
  AppendRuntimeEventReceipt,
  CompleteRuntimeExecution,
  CreateChatActivation,
  RuntimeAudit,
  RuntimeExecutionOutcome
} from "./store/types.js";

export class RuntimeStore {
  readonly #database: DatabaseSync;
  readonly #ownsDatabase: boolean;
  readonly #destinationCache = new Map<string, RuntimeDestination>();
  readonly #query: RuntimeStoreQuery;
  readonly #chat: RuntimeChatStore;
  readonly #delivery: RuntimeDeliveryStore;
  readonly #eventStore: RuntimeEventStore;
  readonly #audit: RuntimeAuditQuery;
  readonly #onWorkAvailable: () => void;

  public constructor(
    database: string | DatabaseSync,
    options: { readonly migrate?: boolean } = {}
  ) {
    const databasePath = typeof database === "string"
      ? resolve(database)
      : mainDatabasePath(database);
    if (typeof database === "string") {
      const absolutePath = resolve(database);
      mkdirSync(dirname(absolutePath), { recursive: true });
      this.#database = openInitializedRuntimeDatabase(
        absolutePath,
        migrateRuntimeDatabase
      );
      this.#ownsDatabase = true;
    } else {
      this.#database = database;
      this.#ownsDatabase = false;
      if (options.migrate !== false) migrateRuntimeDatabase(this.#database);
    }
    this.#onWorkAvailable = () => notifyRuntimeWork(databasePath);
    this.#query = new RuntimeStoreQuery(this.#database, this.#destinationCache);
    this.#chat = new RuntimeChatStore(this.#database, this.#query);
    this.#delivery = new RuntimeDeliveryStore(
      this.#database,
      this.#destinationCache,
      this.#query
    );
    this.#eventStore = new RuntimeEventStore(this.#database, this.#query);
    this.#audit = new RuntimeAuditQuery(this.#query);
  }

  public appendEvent(input: CreateEvent): AppendRuntimeEventReceipt {
    return this.withImmediateTransaction(() => this.appendEventInTransaction(input));
  }

  public appendEventInTransaction(input: CreateEvent): AppendRuntimeEventReceipt {
    const receipt = this.#eventStore.appendInTransaction(input);
    if (receipt.status === "accepted") this.#onWorkAvailable();
    return receipt;
  }

  public withImmediateTransaction<T>(callback: () => T): T {
    return runImmediateTransaction(this.#database, callback);
  }

  public event(eventId: string): Event | undefined {
    return this.#query.event(eventId);
  }

  public events(limit = 100): Event[] {
    return this.#query.events(limit);
  }

  public eventsForRoot(rootEventId: string): Event[] {
    return this.#query.eventsForRoot(rootEventId);
  }

  public latestChatActivation(topicId: string) {
    return this.#query.latestChatActivation(topicId);
  }

  public latestChatDispatch(topicId: string, agentId: string) {
    return this.#query.latestChatDispatch(topicId, agentId);
  }

  public chatMessages(topicId: string): ChatMessageEvent[] {
    return this.#query.chatMessages(topicId);
  }

  public chatPresence(
    agentId: string,
    topicId: string
  ): { readonly global?: ChatPresence; readonly topic?: ChatPresence } {
    return this.#query.chatPresence(agentId, topicId);
  }

  public setChatPresence(
    agentId: string,
    topicId: string,
    presenceInput: ChatPresence,
    at = new Date().toISOString()
  ): ChatPresence {
    return this.#chat.setPresence(agentId, topicId, presenceInput, at);
  }

  public chatAttentionReceipts(sourceMessageEventId: string): ChatAttentionReceipt[] {
    return this.#query.chatAttentionReceipts(sourceMessageEventId);
  }

  public chatDecisionReceipt(dispatchEventId: string): ChatDecisionReceipt | undefined {
    return this.#query.chatDecisionReceipt(dispatchEventId);
  }

  public admitChatAttention(
    executionId: string,
    admissions: readonly AdmitChatAttention[],
    at = new Date().toISOString()
  ): readonly ChatDispatchEvent[] {
    const dispatches = this.#chat.admitAttention(executionId, admissions, at);
    if (dispatches.length > 0) this.#onWorkAvailable();
    return dispatches;
  }

  public createChatActivation(
    input: CreateChatActivation,
    at = new Date().toISOString()
  ): AppendRuntimeEventReceipt {
    const receipt = this.#chat.createActivation(input, at);
    if (receipt.status === "accepted") this.#onWorkAvailable();
    return receipt;
  }

  public createChatActivationInTransaction(
    input: CreateChatActivation,
    at = new Date().toISOString()
  ): AppendRuntimeEventReceipt {
    const receipt = this.#chat.createActivationInTransaction(input, at);
    if (receipt.status === "accepted") this.#onWorkAvailable();
    return receipt;
  }

  public recordChatRunProposalDeclinedInTransaction(input: {
    readonly sourceMessageEventId: string;
    readonly dispatchEventId: string;
    readonly actorPrincipalId: string;
  }, at: string) {
    return this.#chat.recordRunProposalDeclinedInTransaction(input, at);
  }

  public audit(eventId: string): RuntimeAudit | undefined {
    return this.#audit.audit(eventId);
  }

  public audits(limit = 100): RuntimeAudit[] {
    return this.#audit.audits(limit);
  }

  public auditsForRoot(rootEventId: string): RuntimeAudit[] {
    return this.#audit.auditsForRoot(rootEventId);
  }

  public execution(executionId: string): RuntimeExecution | undefined {
    return this.#query.execution(executionId);
  }

  public executionForEvent(eventId: string): RuntimeExecution | undefined {
    return this.#query.executionForEvent(eventId);
  }

  public executionReceiptJson(executionId: string): string | null {
    return this.#query.executionReceiptJson(executionId);
  }

  public nextDueExecutionAt(): string | undefined {
    return this.#query.nextDueExecutionAt();
  }

  public executionSchedulingSnapshot(at = new Date().toISOString()) {
    return this.#query.executionSchedulingSnapshot(iso(at));
  }

  public nextFutureExecutionAt(at: string): string | undefined {
    return this.#query.nextFutureExecutionAt(iso(at));
  }

  public claimDueExecutions(
    limit = 20,
    now = new Date().toISOString(),
    select?: (snapshot: ReturnType<RuntimeStore["executionSchedulingSnapshot"]>) => readonly RuntimeExecution[]
  ): RuntimeExecution[] {
    const timestamp = iso(now);
    limit = bounded(limit, 1, 100, "limit");
    return runImmediateTransaction(this.#database, () => {
      const rows = select === undefined ? this.#database.prepare(`
        SELECT execution_id FROM executions
        WHERE status IN ('queued', 'retry_wait') AND julianday(next_attempt_at) <= julianday(?)
        ORDER BY next_attempt_at ASC, created_at ASC, execution_id ASC LIMIT ?
      `).all(timestamp, limit) as unknown as Array<{ execution_id: string }>
        : select(this.executionSchedulingSnapshot(timestamp)).slice(0, limit).map(item => ({ execution_id: item.executionId }));
      const claimed: RuntimeExecution[] = [];
      for (const row of rows) {
        const changed = this.#database.prepare(`
          UPDATE executions SET status = 'running', attempt_count = attempt_count + 1,
            started_at = ?, updated_at = ?
          WHERE execution_id = ? AND status IN ('queued', 'retry_wait')
        `).run(timestamp, timestamp, row.execution_id);
        if (changed.changes === 1) claimed.push(this.#requireExecution(row.execution_id));
      }
      return claimed;
    });
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
    const outcome = runImmediateTransaction(this.#database, () => {
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
      if (event.type !== "chat.dispatch" && receipt.chatReplyRoute !== undefined) {
        throw new Error(`Chat reply route is only valid for chat.dispatch: ${event.eventId}`);
      }
      if (event.type === "chat.dispatch" && receipt.chatDecision !== undefined) {
        const expectedSchemas = event.promptResourceId === chatMentionPromptResourceId
          ? ["ChatMentionDecision@1", "ChatMentionDecision@2"]
          : ["ChatDecision@1", "ChatDecision@2"];
        if (!expectedSchemas.includes(receipt.chatDecision.schema)) {
          throw new Error(
            `Chat Agent outcome must use ${expectedSchemas.join(" or ")} for ` +
              event.promptResourceId
          );
        }
      }
      if (event.sessionId !== undefined && receipt.sessionId !== undefined &&
        event.sessionId !== receipt.sessionId) {
        throw new Error(`Execution Session changed while handling Event: ${event.eventId}`);
      }
      const runId = event.type === "agent.request"
        ? event.runContext?.runId
        : undefined;
      const cycleId = event.type === "agent.request"
        ? event.runContext?.cycleId
        : undefined;
      const sessionId = event.sessionId ?? receipt.sessionId;
      let session: RuntimeSession;
      if (sessionId === undefined) {
        session = this.#createSession(event.agentId, runId, cycleId, receipt, timestamp);
      } else {
        session = this.#requireSession(sessionId);
        if (session.agentId !== event.agentId || session.adapterId !== receipt.adapterId ||
          session.workspace !== receipt.workspace ||
          session.providerSessionId !== receipt.providerSessionId ||
          session.runId !== runId || session.cycleId !== cycleId) {
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
          this.#chat.applyPresence(event, decision.presence, timestamp);
        }
        const reply = decision.speech.action === "reply"
          ? this.#chat.createReply(
              event,
              session.sessionId,
              decision.speech.body,
              timestamp,
              receipt.chatReplyRoute?.continueAttention ?? true
            )
          : undefined;
        if (reply !== undefined && receipt.chatReplyRoute?.delivery !== undefined) {
          const delivery = receipt.chatReplyRoute.delivery;
          this.enqueueHostDeliveryInTransaction({
            originId: reply.eventId,
            destinationId: delivery.destinationId,
            kind: delivery.kind,
            address: delivery.address,
            payload: { body: reply.body },
            at: timestamp
          });
        }
        this.#database.prepare(`
          UPDATE executions SET receipt_json = ? WHERE execution_id = ?
        `).run(JSON.stringify({
          schema: decision.schema.endsWith("@2")
            ? "ChatDecisionReceipt@2"
            : "ChatDecisionReceipt@1",
          dispatchEventId: event.eventId,
          sessionId: session.sessionId,
          speechAction: decision.speech.action,
          ...(decision.speech.action === "silent"
            ? { silenceReason: decision.speech.reason }
            : {}),
          ...(decision.speech.action === "propose_run"
            ? { proposal: decision.speech.proposal }
            : {}),
          ...("presence" in decision
            ? { presenceTransition: decision.presence }
            : {}),
          ...(reply === undefined ? {} : { replyEventId: reply.eventId }),
          ...(event.profileContext === undefined
            ? {}
            : {
                profileRevisions: {
                  schema: "ChatProfileRevisionReceipt@1",
                  agentId: event.profileContext.agent.agentId,
                  agentRevision: event.profileContext.agent.revision,
                  topicId: event.profileContext.topic.topicId,
                  topicRevision: event.profileContext.topic.revision,
                  resolvedAt: event.profileContext.resolvedAt
                }
              }),
          ...(receipt.invocation === undefined ? {} : { invocation: receipt.invocation }),
          createdAt: timestamp
        }), executionId);
        return reply;
      }
      const resultEvent = this.#eventStore.createResult({
        execution,
        event,
        outcome: "succeeded",
        sessionId: session.sessionId,
        output: receipt.output!,
        at: timestamp
      });
      if (receipt.invocation !== undefined) {
        this.#database.prepare(`
          UPDATE executions SET receipt_json = ? WHERE execution_id = ?
        `).run(JSON.stringify({
          schema: "AgentInvocationReceipt@1",
          invocation: receipt.invocation
        }), executionId);
      }
      return resultEvent;
    });
    this.#onWorkAvailable();
    return outcome;
  }

  public failExecution(
    executionId: string,
    error: string,
    at = new Date().toISOString(),
    retryBaseMilliseconds = 1_000,
    options: FailRuntimeExecutionOptions = {}
  ): { readonly execution: RuntimeExecution; readonly resultEvent?: AgentResultEvent } {
    const failure = requireText(error, "error").slice(0, 4_096);
    const timestamp = iso(at);
    const outcome = runImmediateTransaction(this.#database, () => {
      const execution = this.#requireExecution(executionId);
      if (execution.status !== "running") throw new Error(`execution is not running: ${executionId}`);
      const normalizedTrace = options.trace === undefined
        ? undefined
        : normalizeAgentInvocationFailure(options.trace);
      const traceJson = normalizedTrace === undefined
        ? null
        : JSON.stringify({ schema: "AgentInvocationFailureReceipt@1", trace: normalizedTrace });
      if (traceJson !== null && Buffer.byteLength(traceJson, "utf8") > 65_536) {
        throw new Error("Agent invocation failure receipt exceeds 65536 bytes");
      }
      if (options.retry !== "never" && execution.attemptCount < execution.maxAttempts) {
        const next = annealedRetryAt(timestamp, execution.attemptCount, retryBaseMilliseconds);
        this.#database.prepare(`
          UPDATE executions SET status = 'retry_wait', next_attempt_at = ?, last_error = ?,
            started_at = NULL, updated_at = ?, receipt_json = COALESCE(?, receipt_json)
          WHERE execution_id = ?
        `).run(next, failure, timestamp, traceJson, executionId);
        const retried = this.#requireExecution(executionId);
        return { execution: retried };
      }
      this.#database.prepare(`
        UPDATE executions SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?,
          receipt_json = COALESCE(?, receipt_json)
        WHERE execution_id = ?
      `).run(failure, timestamp, timestamp, traceJson, executionId);
      const event = this.#requireEvent(execution.eventId);
      const failed = this.#requireExecution(executionId);
      const resultEvent = execution.handler === "agent" &&
        isAgentInputEvent(event) &&
        event.type !== "chat.dispatch"
        ? this.#eventStore.createResult({
          execution,
          event,
          outcome: "failed",
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          error: failure,
          at: timestamp
        })
        : undefined;
      return {
        execution: failed,
        ...(resultEvent === undefined ? {} : { resultEvent })
      };
    });
    this.#onWorkAvailable();
    return outcome;
  }

  public completeResultExecution(
    executionId: string,
    at = new Date().toISOString()
  ): RuntimeDelivery[] {
    return this.withImmediateTransaction(
      () => this.completeResultExecutionInTransaction(executionId, at)
    );
  }

  public completeResultExecutionInTransaction(
    executionId: string,
    at = new Date().toISOString()
  ): RuntimeDelivery[] {
    const timestamp = iso(at);
    const execution = this.#requireExecution(executionId);
    if (execution.status !== "running" || execution.handler !== "result") {
      throw new Error(`result execution is not running: ${executionId}`);
    }
    const resultEvent = this.#requireEvent(execution.eventId);
    if (resultEvent.type !== "agent.result") {
      throw new Error(`ResultHandler requires agent.result: ${resultEvent.eventId}`);
    }
    for (const destination of this.destinationSnapshots(resultEvent.eventId)) {
      const maxAttempts = destination.kind === "macos-notification" || destination.kind === "codex-desktop" ? 1 : 5;
      this.#database.prepare(`
        INSERT INTO deliveries (
          delivery_id, result_event_id, origin_kind, origin_id, destination_id,
          destination_kind, destination_address_json, payload_json,
          status, attempt_count, max_attempts,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, 'event', ?, ?, ?, ?, '{}', 'pending', 0, ?, ?, ?, ?)
        ON CONFLICT(origin_kind, origin_id, destination_id) DO NOTHING
      `).run(
        runtimeId("del"),
        resultEvent.eventId,
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
    this.#onWorkAvailable();
    return deliveries;
  }

  public cancelQueuedExecutionsForRootInTransaction(
    rootEventId: string,
    at = new Date().toISOString()
  ): number {
    const timestamp = iso(at);
    return Number(this.#database.prepare(`
      UPDATE executions
      SET status = 'cancelled', completed_at = ?, updated_at = ?,
        last_error = 'agent_run_cancelled'
      WHERE event_id IN (
        SELECT event_id FROM events WHERE root_event_id = ?
      ) AND status IN ('queued', 'retry_wait')
    `).run(timestamp, timestamp, requireEventId(rootEventId, "rootEventId")).changes);
  }

  public cancelRunningAgentExecution(
    executionId: string,
    reason: string,
    at = new Date().toISOString()
  ): RuntimeExecution {
    const timestamp = iso(at);
    const execution = this.#requireExecution(executionId);
    if (execution.handler !== "agent" || execution.status !== "running") {
      throw new Error(`Agent execution is not running: ${executionId}`);
    }
    const boundedReason = requireText(reason, "reason").slice(0, 4_096);
    const changed = this.#database.prepare(`
      UPDATE executions
      SET status = 'cancelled', completed_at = ?, updated_at = ?, last_error = ?,
        receipt_json = ?
      WHERE execution_id = ? AND status = 'running'
    `).run(
      timestamp,
      timestamp,
      boundedReason,
      JSON.stringify({
        schema: "RuntimeExecutionSkipReceipt@1",
        reason: boundedReason,
        createdAt: timestamp
      }),
      executionId
    );
    if (changed.changes !== 1) {
      throw new Error(`Agent execution cancellation CAS failed: ${executionId}`);
    }
    return this.#requireExecution(executionId);
  }

  public failExecutionsForEventsInTransaction(
    eventIds: readonly string[],
    reason: string,
    at = new Date().toISOString()
  ): number {
    if (eventIds.length > 1_000) throw new Error("eventIds exceeds 1000 items");
    if (eventIds.length === 0) return 0;
    const timestamp = iso(at);
    const ids = eventIds.map((eventId) => requireEventId(eventId, "eventId"));
    const placeholders = ids.map(() => "?").join(", ");
    return Number(this.#database.prepare(`
      UPDATE executions SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?
      WHERE event_id IN (${placeholders}) AND status IN ('queued', 'retry_wait', 'running')
    `).run(requireText(reason, "reason").slice(0, 4_096), timestamp, timestamp, ...ids).changes);
  }

  public recordExecutionReceiptInTransaction(
    executionId: string,
    receipt: Readonly<Record<string, unknown>>
  ): void {
    const encoded = JSON.stringify(receipt);
    if (Buffer.byteLength(encoded, "utf8") > 65_536) {
      throw new Error("Execution receipt exceeds 65536 bytes");
    }
    const changed = this.#database.prepare(`
      UPDATE executions SET receipt_json = ? WHERE execution_id = ?
    `).run(encoded, requireRuntimeId(executionId, "exe", "executionId"));
    if (changed.changes !== 1) throw new Error(`Execution not found: ${executionId}`);
  }

  public recordAgentInvocationProgress(
    executionId: string,
    progress: AgentInvocationProgress
  ): void {
    const normalized = normalizeAgentInvocationProgress(progress);
    const encoded = JSON.stringify({
      schema: "AgentInvocationProgressReceipt@1",
      trace: normalized
    });
    if (Buffer.byteLength(encoded, "utf8") > 65_536) {
      throw new Error("Agent invocation progress receipt exceeds 65536 bytes");
    }
    const changed = this.#database.prepare(`
      UPDATE executions SET receipt_json = ?, updated_at = ?
      WHERE execution_id = ? AND status = 'running' AND handler = 'agent'
    `).run(
      encoded,
      normalized.observedAt,
      requireRuntimeId(executionId, "exe", "executionId")
    );
    if (changed.changes !== 1) {
      throw new Error(`Agent execution is not running: ${executionId}`);
    }
  }

  public recoverReadOnlySessionInTransaction(
    executionId: string,
    at = new Date().toISOString()
  ): RuntimeSession | undefined {
    const execution = this.#requireExecution(executionId);
    const event = this.#requireEvent(execution.eventId);
    if (!isAgentInputEvent(event) || event.type !== "agent.request" ||
      event.runContext === undefined) return undefined;
    if (event.runContext?.workspaceGrant?.access === "write") return undefined;
    if (event.sessionId !== undefined) return this.#requireSession(event.sessionId);
    const trace = parseAgentInvocationFailureReceipt(
      this.executionReceiptJson(execution.executionId)
    );
    if (trace?.recovery !== "explicit_read_only_resume" ||
      trace.workspaceAccess !== "read" || trace.providerSessionId === undefined) return undefined;
    const existing = this.sessionForProvider(trace.adapterId, trace.providerSessionId);
    if (existing !== undefined) {
      if (existing.agentId !== event.agentId ||
        existing.runId !== event.runContext.runId ||
        existing.cycleId !== event.runContext.cycleId ||
        existing.adapterId !== trace.adapterId ||
        existing.workspace !== trace.workspace) {
        throw new Error("Recoverable provider Session belongs to a different Runtime scope");
      }
      return existing;
    }
    return this.#createSession(
      event.agentId,
      event.runContext?.runId,
      event.runContext?.cycleId,
      {
        adapterId: trace.adapterId,
        workspace: trace.workspace,
        providerSessionId: trace.providerSessionId
      },
      iso(at)
    );
  }

  public forceTerminalAgentFailure(
    executionId: string,
    error: string,
    at = new Date().toISOString()
  ): { readonly execution: RuntimeExecution; readonly resultEvent?: AgentResultEvent } {
    const failure = requireText(error, "error").slice(0, 4_096);
    const timestamp = iso(at);
    const outcome = this.withImmediateTransaction(() => {
      const execution = this.#requireExecution(executionId);
      if (execution.status !== "running" || execution.handler !== "agent") {
        throw new Error(`agent execution is not running: ${executionId}`);
      }
      this.#database.prepare(`
        UPDATE executions SET status = 'failed', last_error = ?,
          completed_at = ?, updated_at = ? WHERE execution_id = ?
      `).run(failure, timestamp, timestamp, executionId);
      const event = this.#requireEvent(execution.eventId);
      const resultEvent = isAgentInputEvent(event) && event.type !== "chat.dispatch"
        ? this.#eventStore.createResult({
            execution,
            event,
            outcome: "failed",
            ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
            error: failure,
            at: timestamp
          })
        : undefined;
      return {
        execution: this.#requireExecution(executionId),
        ...(resultEvent === undefined ? {} : { resultEvent })
      };
    });
    this.#onWorkAvailable();
    return outcome;
  }

  public session(sessionId: string): RuntimeSession | undefined {
    return this.#query.session(sessionId);
  }

  public sessionForProvider(
    adapterId: string,
    providerSessionId: string
  ): RuntimeSession | undefined {
    return this.#query.sessionForProvider(adapterId, providerSessionId);
  }

  public sessionForRunAgent(
    runId: string,
    agentId: string,
    cycleId?: string
  ): RuntimeSession | undefined {
    return this.#query.sessionForRunAgent(runId, agentId, cycleId);
  }

  public currentLocalAgentSession(agentId: string): RuntimeSession | undefined {
    return this.#query.currentLocalAgentSession(agentId);
  }

  public reconcileCurrentLocalAgentSession(
    agentId: string,
    adapterId: string,
    workspace: string,
    at = new Date().toISOString()
  ): boolean {
    const normalizedAgentId = requireText(agentId, "agentId");
    const normalizedAdapterId = requireText(adapterId, "adapterId");
    const normalizedWorkspace = requireText(workspace, "workspace");
    const current = this.currentLocalAgentSession(normalizedAgentId);
    if (current === undefined ||
      (current.adapterId === normalizedAdapterId &&
        current.workspace === normalizedWorkspace)) {
      return false;
    }
    const changed = this.#database.prepare(`
      UPDATE agents
      SET current_session_id = NULL,
        session_generation = session_generation + 1,
        updated_at = ?
      WHERE principal_id = ? AND current_session_id = ?
    `).run(iso(at), normalizedAgentId, current.sessionId).changes;
    return changed === 1;
  }

  public sessions(limit = 100): RuntimeSession[] {
    return this.#query.sessions(limit);
  }

  public sessionIsIdle(sessionId: string): boolean {
    requireRuntimeId(sessionId, "ses", "sessionId");
    return this.#database.prepare(`
      SELECT 1
      FROM executions AS execution
      JOIN events AS event ON event.event_id = execution.event_id
      WHERE event.session_id = ?
        AND execution.handler = 'agent'
        AND execution.status IN ('queued', 'running', 'retry_wait')
      LIMIT 1
    `).get(sessionId) === undefined;
  }

  public putDestination(input: {
    readonly destinationId?: string;
    readonly kind: RuntimeDestination["kind"];
    readonly address: Readonly<Record<string, string>>;
    readonly at?: string;
  }): RuntimeDestination {
    return this.#delivery.putDestination(input);
  }

  public destination(destinationId: string): RuntimeDestination | undefined {
    return this.#query.destination(destinationId);
  }

  public destinations(limit = 100): RuntimeDestination[] {
    return this.#query.destinations(limit);
  }

  public deliveriesForResultEvent(resultEventId: string): RuntimeDelivery[] {
    return this.#query.deliveriesForResultEvent(resultEventId);
  }

  public enqueueHostDelivery(input: {
    readonly originId: string;
    readonly destinationId: string;
    readonly kind: RuntimeDestination["kind"];
    readonly address: Readonly<Record<string, string>>;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly maxAttempts?: number;
    readonly at?: string;
  }): RuntimeDelivery {
    return this.withImmediateTransaction(() => this.enqueueHostDeliveryInTransaction(input));
  }

  public enqueueHostDeliveryInTransaction(
    input: Parameters<RuntimeDeliveryStore["enqueueHostInTransaction"]>[0]
  ): RuntimeDelivery {
    const delivery = this.#delivery.enqueueHostInTransaction(input);
    this.#onWorkAvailable();
    return delivery;
  }

  public claimDueDeliveries(
    limit = 100,
    now = new Date().toISOString()
  ): RuntimeDelivery[] {
    return this.#delivery.claimDue(limit, now);
  }

  public deliverySucceeded(
    deliveryId: string,
    receipt: string,
    at = new Date().toISOString()
  ): RuntimeDelivery {
    return this.#delivery.succeeded(deliveryId, receipt, at);
  }

  public retryFailedDelivery(
    deliveryId: string,
    at = new Date().toISOString()
  ): RuntimeDelivery {
    const delivery = this.#delivery.retryFailed(deliveryId, at);
    this.#onWorkAvailable();
    return delivery;
  }

  public deliveryFailed(
    deliveryId: string,
    error: string,
    at = new Date().toISOString(),
    retryBaseMilliseconds = 1_000
  ): RuntimeDelivery {
    const delivery = this.#delivery.failed(deliveryId, error, at, retryBaseMilliseconds);
    this.#onWorkAvailable();
    return delivery;
  }

  public delivery(deliveryId: string): RuntimeDelivery | undefined {
    return this.#query.delivery(deliveryId);
  }

  public nextDueDeliveryAt(): string | undefined {
    return this.#query.nextDueDeliveryAt();
  }

  public deliveriesForDestinationKind(
    kind: RuntimeDestination["kind"],
    limit = 100
  ): RuntimeDelivery[] {
    return this.#query.deliveriesForDestinationKind(kind, limit);
  }

  public reconcileInterrupted(at = new Date().toISOString()): number {
    const timestamp = iso(at);
    return runImmediateTransaction(this.#database, () => {
      const interruptedAgents = this.#database.prepare(`
        SELECT execution_id FROM executions
        WHERE status = 'running' AND handler = 'agent'
        ORDER BY started_at, execution_id
      `).all() as unknown as Array<{ execution_id: string }>;
      for (const row of interruptedAgents) {
        const execution = this.#requireExecution(row.execution_id);
        const event = this.#requireEvent(execution.eventId);
        this.#database.prepare(`
          UPDATE executions
          SET status = 'failed', next_attempt_at = ?,
            last_error = 'runtime_interrupted_unknown', completed_at = ?, updated_at = ?,
            receipt_json = ?
          WHERE execution_id = ? AND status = 'running' AND handler = 'agent'
        `).run(
          timestamp,
          timestamp,
          timestamp,
          JSON.stringify({
            schema: "AgentInvocationRecoveryReceipt@1",
            outcome: "unknown",
            reason: "runtime_interrupted",
            replayed: false,
            createdAt: timestamp
          }),
          execution.executionId
        );
        if (isAgentInputEvent(event) && event.type !== "chat.dispatch") {
          this.#eventStore.createResult({
            execution,
            event,
            outcome: "failed",
            ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
            error: "runtime_interrupted_unknown",
            at: timestamp
          });
        }
      }
      const exhaustedExecutions = this.#database.prepare(`
        UPDATE executions SET status = 'failed', next_attempt_at = ?,
          last_error = 'runtime_interrupted', completed_at = ?, updated_at = ?
        WHERE status = 'running' AND handler <> 'agent' AND attempt_count >= max_attempts
      `).run(timestamp, timestamp, timestamp).changes;
      const retryableExecutions = this.#database.prepare(`
        UPDATE executions SET status = 'retry_wait', next_attempt_at = ?,
          last_error = 'runtime_interrupted', started_at = NULL, updated_at = ?
        WHERE status = 'running' AND handler <> 'agent' AND attempt_count < max_attempts
      `).run(timestamp, timestamp).changes;
      const exhaustedDeliveries = this.#database.prepare(`
        UPDATE deliveries SET status = 'failed', next_attempt_at = ?,
          last_error = CASE WHEN destination_kind = 'codex-desktop' THEN 'runtime_interrupted_unknown' ELSE 'runtime_interrupted' END, updated_at = ?
        WHERE status = 'delivering' AND attempt_count >= max_attempts
      `).run(timestamp, timestamp).changes;
      const retryableDeliveries = this.#database.prepare(`
        UPDATE deliveries SET status = 'retry_wait', next_attempt_at = ?,
          last_error = 'runtime_interrupted', updated_at = ?
        WHERE status = 'delivering' AND attempt_count < max_attempts
      `).run(timestamp, timestamp).changes;
      return interruptedAgents.length + Number(exhaustedExecutions) + Number(retryableExecutions) +
        Number(exhaustedDeliveries) +
        Number(retryableDeliveries);
    });
  }

  public close(): void {
    if (this.#ownsDatabase) this.#database.close();
  }

  #createSession(
    agentId: string,
    runId: string | undefined,
    cycleId: string | undefined,
    receipt: CompleteRuntimeExecution,
    timestamp: string
  ): RuntimeSession {
    const sessionId = runtimeId("ses");
    this.#database.prepare(`
      INSERT INTO agent_sessions (
        session_id, agent_id, run_id, cycle_id, adapter_id, provider_session_id,
        workspace, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      agentId,
      runId ?? null,
      cycleId ?? null,
      receipt.adapterId,
      receipt.providerSessionId,
      receipt.workspace,
      timestamp,
      timestamp
    );
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

  public destinationSnapshots(eventId: string) {
    return this.#query.destinationSnapshots(eventId);
  }

}

function mainDatabasePath(database: DatabaseSync): string | undefined {
  const row = (database.prepare("PRAGMA database_list").all() as unknown as Array<{
    name: string;
    file: string;
  }>).find((item) => item.name === "main");
  return row?.file.trim() ? resolve(row.file) : undefined;
}
