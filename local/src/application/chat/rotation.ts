import { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { requireEventId, type ChatActivationEvent, type ChatMessageEvent } from "../../core/event/model.js";
import type { RuntimeExecution } from "../../core/runtime/model.js";
import type { RuntimeStore } from "../../core/runtime/store.js";
import { chatAttentionReceipt } from "../../core/runtime/store/codec.js";
import type { AdmitChatAttention } from "../../core/runtime/store/types.js";
import type { ChatHandler, ChatAttentionScheduler } from "./handler.js";
import {
  chatRotationStatus, completeChatRotationTurn, createChatRotationState,
  offerChatRotationMessage, parseChatRotationState, startChatRotationTurn, type ChatRotationState
} from "./rotation-state.js";

interface Rotation {
  sourceEventId: string;
  state: ChatRotationState;
  dispatchEventId?: string;
  ownerEventIds: string[];
  settled?: boolean;
}

/** Source ingestion and each dispatch admission commit with the Topic queue.
 * Execution remains the only authority for invocation and terminal outcomes. */
export class ChatRotation implements ChatAttentionScheduler {
  constructor(
    readonly database: DatabaseSync,
    readonly runtime: RuntimeStore,
    readonly shuffle: (ids: readonly string[]) => string[] = shuffled
  ) {}

  accepts(event: ChatMessageEvent | ChatActivationEvent): boolean {
    if (event.type !== "chat.message") return false;
    const targetCount = event.targets?.length ?? 0;
    if (targetCount > 0 && (event.sender.kind !== "owner" || targetCount === 1)) return false;
    // Source-owned callback/session contracts keep their existing admission path.
    return this.runtime.event(event.causality.rootEventId)?.type !== "chat.activation";
  }

  ingest(execution: RuntimeExecution, event: ChatMessageEvent | ChatActivationEvent,
    admissions: readonly AdmitChatAttention[], at: string): readonly string[] {
    if (event.type !== "chat.message") throw new Error("Rotation requires a Chat message");
    this.runtime.withImmediateTransaction(() => {
      if (this.runtime.execution(execution.executionId)?.status !== "running") {
        throw new Error("Chat attention source is no longer running");
      }
      const eligible = admissions.filter(({plan}) => plan.outcome === "dispatch")
        .map(({plan}) => plan.agentId);
      const previous = this.read(event.topicId);
      // A historical Agent reply cannot open a new discussion on migration.
      // It can join a discussion already opened by an Owner source.
      const rotation = previous ?? {
        sourceEventId: event.eventId,
        state: createChatRotationState(eligible, {turnBudget: event.conversation?.turnBudget ?? 8}),
        ownerEventIds: []
      };
      if (event.sender.kind === "owner") {
        rotation.state = offerChatRotationMessage(rotation.state, {ownerOrder: this.shuffle([
          ...new Set([...eligible, ...(rotation.settled === true ? []
            : [...rotation.state.currentQueue, ...rotation.state.nextPending])])
        ])});
        rotation.ownerEventIds.push(event.eventId);
      } else if (previous !== undefined && event.sender.kind === "agent") {
        rotation.state = offerChatRotationMessage(rotation.state,
          {senderAgentId: event.sender.principalId!});
      }
      rotation.sourceEventId = event.eventId;
      delete rotation.settled;
      const receipts = admissions.map(({plan}) => chatAttentionReceipt(event.eventId, plan,
        undefined, undefined, at));
      this.database.prepare(`UPDATE executions SET status = 'succeeded', completed_at = ?,
        updated_at = ?, receipt_json = ? WHERE execution_id = ?`).run(at, at,
        JSON.stringify({schema: "ChatAttentionReceiptList@1", receipts}), execution.executionId);
      if (event.sender.kind === "owner" || previous !== undefined) this.write(event.topicId, rotation, at);
    });
    return [];
  }

  /** Called by the existing runtime loop; never waits for a provider or a Run. */
  advance(handler: Pick<ChatHandler, "prepare">, at = new Date().toISOString()): readonly string[] {
    const topics = this.database.prepare(`SELECT topic_id FROM chat_rotations rotation
      WHERE json_extract(state_json, '$.settled') IS NOT 1 AND NOT EXISTS (
        SELECT 1 FROM executions x JOIN events e ON e.event_id = x.event_id
        WHERE json_extract(e.payload_json,'$.topicId') = rotation.topic_id
          AND x.status IN ('queued','running','retry_wait')
          AND (x.handler = 'chat' OR e.type = 'chat.dispatch')
      ) ORDER BY updated_at, topic_id LIMIT 20`)
      .all() as {topic_id: string}[];
    const dispatched: string[] = [];
    for (const {topic_id: topicId} of topics) {
      this.runtime.withImmediateTransaction(() => {
        const rotation = this.read(topicId)!;
        // Ingest every already-arrived source before freezing the next prompt.
        // Also drain legacy/targeted invocations; adding rotation never overlaps them.
        const busy = this.database.prepare(`SELECT 1 FROM executions x JOIN events e ON e.event_id=x.event_id
          WHERE json_extract(e.payload_json,'$.topicId') = ?
            AND x.status IN ('queued','running','retry_wait')
            AND (x.handler = 'chat' OR e.type = 'chat.dispatch') LIMIT 1`).get(topicId);
        if (busy !== undefined) return;
        if (rotation.state.active !== null) {
          const execution = rotation.dispatchEventId === undefined ? undefined
            : this.runtime.executionForEvent(rotation.dispatchEventId);
          if (execution === undefined) throw new Error("Rotation active dispatch is missing");
          rotation.state = completeChatRotationTurn(rotation.state, rotation.state.active,
            execution.status === "succeeded" ? "completed" : "failed");
          delete rotation.dispatchEventId;
        }
        const next = startChatRotationTurn(rotation.state);
        if (next === undefined) {
          const status = chatRotationStatus(rotation.state);
          if (status === "budget_exhausted") {
            this.settlePending(rotation, at);
            new LocalChatStore(this.database).postSystemMessageInTransaction({topicId,
              sourceEventId: rotation.sourceEventId,
              idempotencyKey: `rotation-budget:${rotation.sourceEventId}`,
              body: `本轮讨论已达到 ${rotation.state.turnBudget} 次唤醒上限，已暂停；这不代表所有 Agent 都决定不发言。你可以发言开启下一轮。`, at});
          } else if (rotation.ownerEventIds.length > 0) {
            // Bounded prompts never acknowledge content that was not actually included.
            this.settlePending(rotation, at, "history-not-in-prompt");
            rotation.state = {...rotation.state, failedAgents: [...rotation.state.agentIds]};
            new LocalChatStore(this.database).postSystemMessageInTransaction({topicId,
              sourceEventId: rotation.sourceEventId,
              idempotencyKey: `rotation-history:${rotation.sourceEventId}`,
              body: "部分消息未进入 Agent 的本轮上下文，圆环保留未处理状态。请缩小范围后继续。", at});
          }
          rotation.settled = true;
          this.write(topicId, rotation, at);
          return;
        }
        const latest = this.runtime.event(rotation.sourceEventId);
        if (latest?.type !== "chat.message") throw new Error("Rotation source is missing");
        // Preserve the original wake/Owner authority until this Agent has handled it.
        const pendingOwnerId = rotation.ownerEventIds.findLast((id) =>
          this.runtime.chatAttentionReceipts(id).some((receipt) =>
            receipt.agentId === next.turn.agentId && receipt.outcome === "dispatched" &&
            receipt.dispatchEventId === undefined));
        const source = pendingOwnerId === undefined ? latest : this.runtime.event(pendingOwnerId);
        if (source?.type !== "chat.message") throw new Error("Rotation Owner source is missing");
        const sourceExecution = this.runtime.executionForEvent(source.eventId);
        if (sourceExecution === undefined) throw new Error("Rotation source execution is missing");
        const prepared = handler.prepare(source, at, next.turn.agentId, true, latest);
        const admission = prepared.admissions[0];
        rotation.state = next.state;
        if (admission === undefined || admission.plan.outcome === "skip") {
          this.cover(rotation, next.turn.agentId, undefined, prepared.coveredMessageIds, at,
            admission);
          rotation.state = completeChatRotationTurn(rotation.state, next.turn, "completed");
        } else {
          const dispatch = this.runtime.appendChatAttentionInTransaction(sourceExecution.executionId,
            [admission], at)[0];
          if (dispatch === undefined) {
            // The immutable source's causal budget can also close a turn.
            this.settlePending(rotation, at);
            rotation.state = {...rotation.state, turnsStarted: rotation.state.turnBudget};
            rotation.state = completeChatRotationTurn(rotation.state, next.turn, "failed");
          } else {
            rotation.dispatchEventId = dispatch.eventId;
            this.cover(rotation, next.turn.agentId, dispatch.eventId,
              prepared.coveredMessageIds, at, admission);
            dispatched.push(dispatch.eventId);
          }
        }
        this.write(topicId, rotation, at);
      });
    }
    return dispatched;
  }

  private cover(rotation: Rotation, agentId: string, dispatchEventId: string | undefined,
    coveredIds: readonly string[], at: string, admission?: AdmitChatAttention): void {
    const covered = new Set(coveredIds);
    for (const ownerId of rotation.ownerEventIds) {
      if (!covered.has(ownerId)) continue;
      const receipts = this.runtime.chatAttentionReceipts(ownerId).map((receipt) => {
        if (receipt.agentId !== agentId || receipt.outcome !== "dispatched" ||
          receipt.dispatchEventId !== undefined) return receipt;
        if (dispatchEventId !== undefined) return {...receipt, dispatchEventId};
        return {...receipt, outcome: "skipped" as const,
          reason: admission?.plan.reason ?? "not-target" as const};
      });
      this.saveReceipts(ownerId, receipts, at);
    }
    rotation.ownerEventIds = rotation.ownerEventIds.filter((id) =>
      this.runtime.chatAttentionReceipts(id).some((receipt) =>
        receipt.outcome === "dispatched" && receipt.dispatchEventId === undefined));
  }

  private settlePending(rotation: Rotation, at: string, reason: "turn-budget-exhausted" | "history-not-in-prompt" = "turn-budget-exhausted"): void {
    for (const ownerId of rotation.ownerEventIds) {
      this.saveReceipts(ownerId, this.runtime.chatAttentionReceipts(ownerId).map((receipt) =>
        receipt.outcome === "dispatched" && receipt.dispatchEventId === undefined
          ? {...receipt, outcome: "skipped" as const, reason}
          : receipt), at);
    }
    rotation.ownerEventIds = [];
  }

  private saveReceipts(sourceId: string,
    receipts: ReturnType<RuntimeStore["chatAttentionReceipts"]>, at: string): void {
    this.database.prepare("UPDATE executions SET receipt_json = ?, updated_at = ? WHERE event_id = ? AND handler = 'chat'")
      .run(JSON.stringify({schema: "ChatAttentionReceiptList@1", receipts}), at, sourceId);
  }

  private read(topicId: string): Rotation | undefined {
    const row = this.database.prepare("SELECT state_json FROM chat_rotations WHERE topic_id = ?")
      .get(topicId) as {state_json: string} | undefined;
    if (row === undefined) return undefined;
    const value = JSON.parse(row.state_json) as Record<string, unknown>;
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !Array.isArray(value.ownerEventIds) ||
      (value.settled !== undefined && typeof value.settled !== "boolean")) {
      throw new Error(`Malformed Chat rotation: ${topicId}`);
    }
    const state = parseChatRotationState(value.state);
    const sourceEventId = reference(value.sourceEventId);
    const ownerEventIds = value.ownerEventIds.map((id) => reference(id));
    const dispatchEventId = value.dispatchEventId === undefined ? undefined : reference(value.dispatchEventId);
    if ((state.active === null) !== (dispatchEventId === undefined) ||
      new Set(ownerEventIds).size !== ownerEventIds.length) throw new Error(`Malformed Chat rotation references: ${topicId}`);
    return {sourceEventId, state, ownerEventIds,
      ...(dispatchEventId === undefined ? {} : {dispatchEventId}),
      ...(value.settled === undefined ? {} : {settled: value.settled})};
  }

  private write(topicId: string, rotation: Rotation, at: string): void {
    this.database.prepare(`INSERT INTO chat_rotations(topic_id,state_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(topic_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at`)
      .run(topicId, JSON.stringify(rotation), at);
  }
}

function shuffled(ids: readonly string[]): string[] {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function reference(value: unknown): string {
  if (typeof value !== "string") throw new Error("Chat rotation reference must be an Event ID");
  return requireEventId(value);
}
