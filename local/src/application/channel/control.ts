import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import type { LocalControlOptions } from "../agent/control.js";
import { publishServerTopicMessage } from "../topic/control.js";
import { TopicInboxStore } from "../../infrastructure/files/topic-inbox-store.js";
import { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import { ChannelStore } from "../../infrastructure/sqlite/channel-store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { TopicGovernanceStore } from "../../infrastructure/sqlite/topic-governance-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import {
  markChannelDeliveryAttempted,
  interactiveChannelBindingAvailableAt,
  channelRefAllowed,
  acceptChannelSend,
  channelRefKey,
  createChannelFollow,
  createInteractiveChannelBinding,
  createPendingChannelSend,
  failChannelSend,
  transitionChannelFollow,
  transitionInteractiveChannelBinding,
  type ChannelFollowCondition,
  type ChannelRef,
  type ChannelSendReceipt,
  type InteractiveChannelBinding
} from "../../modules/channel/model.js";
import { materializeLocalTopicGovernance } from "../topic/governance-control.js";

export type { ChannelRef } from "../../modules/channel/model.js";
export { parseChannelRef as parseInteractiveChannelRef } from
  "../../modules/channel/model.js";

export interface ChannelControlOptions extends LocalControlOptions {
  readonly fetch?: typeof fetch;
}

export function bindInteractiveChannel(
  repoRoot: string,
  input: {
    readonly agentId: string;
    readonly allowedChannelRefs: readonly ChannelRef[];
    readonly callbackSessionId?: string;
    readonly expiresAt: string;
  },
  options: ChannelControlOptions = {}
): InteractiveChannelBinding {
  const at = timestamp(options);
  if (input.allowedChannelRefs.some(({ kind }) => kind === "local-chat")) {
    materializeLocalTopicGovernance(repoRoot, options.runtimeDirectory, at);
  }
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  const foundation = new LocalFoundationStore(paths.database);
  const runtime = new RuntimeStore(paths.database);
  const inbox = new TopicInboxStore(paths.topicInbox);
  const store = new ChannelStore(paths.database);
  const governance = new TopicGovernanceStore(paths.database);
  try {
    const agent = foundation.listAgents().find(({ principalId }) => principalId === input.agentId);
    if (agent === undefined || agent.status !== "active") {
      throw new Error(`Active Local Agent not found: ${input.agentId}`);
    }
    for (const ref of input.allowedChannelRefs) {
      if (ref.kind === "local-chat" && ref.channelId !== foundation.foundation()?.topicId) {
        throw new Error(`Local Chat Channel is not owned by this runtime: ${ref.channelId}`);
      }
      if (ref.kind === "local-chat" && !activeTopicParticipant(
        governance, ref.channelId, input.agentId
      )) {
        throw new Error(`Agent is not an active Local Topic participant: ${input.agentId}`);
      }
      if (ref.kind === "server-topic" &&
        inbox.participant(ref.channelId, input.agentId) === undefined) {
        throw new Error(`Agent is not enrolled in Server Topic: ${ref.channelId}`);
      }
    }
    if (input.callbackSessionId !== undefined) {
      const session = runtime.session(input.callbackSessionId);
      if (session === undefined || session.agentId !== input.agentId) {
        throw new Error("Callback Session must exist and belong to the bound Agent");
      }
    }
    return store.createBinding(createInteractiveChannelBinding(input, at));
  } finally {
    store.close();
    governance.close();
    runtime.close();
    foundation.close();
  }
}

export function revokeInteractiveChannel(
  repoRoot: string,
  bindingId: string,
  expectedRevision: number,
  options: ChannelControlOptions = {}
) {
  const store = new ChannelStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
  try {
    const current = store.requireBinding(bindingId);
    if (current.revision !== expectedRevision) {
      return { outcome: "conflict" as const, binding: current };
    }
    if (current.status === "revoked") return { outcome: "unchanged" as const, binding: current };
    const binding = store.commitBinding({
      bindingId,
      expectedRevision,
      next: transitionInteractiveChannelBinding(current, "revoked", timestamp(options))
    });
    return { outcome: "applied" as const, binding };
  } finally {
    store.close();
  }
}

export interface ChannelSendInput {
    readonly bindingId: string;
    readonly channelRef: ChannelRef;
    readonly idempotencyKey: string;
    readonly body: string;
    readonly followCondition?: ChannelFollowCondition;
    readonly quietWindowMilliseconds?: number;
    readonly followDeadlineAt?: string;
}

/** Admission only: the unique Runtime loop owns eventual delivery and follow. */
export function reserveInteractiveChannelMessage(database: DatabaseSync, input: ChannelSendInput,
  at: string, observedServerCursor?: string, notifyBoundSession = true) {
  const store = new ChannelStore(database, {migrate:false});
  try {
    const binding = store.requireBinding(input.bindingId);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      channelRef: input.channelRef,
      body: input.body,
      followCondition: input.followCondition ?? "quiet",
      quietWindowMilliseconds: input.quietWindowMilliseconds ?? 5_000,
      followDeadlineAt: input.followDeadlineAt ?? null,
      ...(!notifyBoundSession ? {notifyBoundSession:false} : {})
    })).digest("hex");
    const existing = store.sendForIdempotency(input.bindingId, input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== fingerprint || existing.body !== input.body ||
        channelRefKey(existing.channelRef) !== channelRefKey(input.channelRef)) {
        throw new Error("Channel send idempotency key has different input");
      }
      return {created:false,receipt:existing,follow:store.requireFollow(existing.followToken)};
    }
    const observedCursor = input.channelRef.kind === "server-topic"
      ? observedServerCursor
      : undefined;
    const pending = createPendingChannelSend({
      binding,
      channelRef: input.channelRef,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      body: input.body,
      ...(observedCursor === undefined ? {} : { observedCursor }),
      at
    });
    const follow = createChannelFollow({
      followToken: pending.followToken,
      sendId: pending.sendId,
      bindingId: binding.bindingId,
      bindingRevision: binding.revision,
      channelRef: input.channelRef,
      ...(observedCursor === undefined ? {} : { afterCursor: observedCursor }),
      condition: input.followCondition ?? "quiet",
      quietWindowMilliseconds: input.quietWindowMilliseconds ?? 5_000,
      deadlineAt: input.followDeadlineAt ??
        new Date(Date.parse(at) + 5 * 60_000).toISOString(),
      ...(!notifyBoundSession || binding.callbackSessionId === undefined
        ? {} : { callbackSessionId: binding.callbackSessionId })
    }, at);
    return store.reserveSend({ receipt: pending, follow });

  } finally { store.close(); }
}

export async function sendInteractiveChannelMessage(repoRoot: string, input: ChannelSendInput,
  options: ChannelControlOptions = {}) {
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  const database = openRuntimeDatabase(paths.database);
  const runtime = new RuntimeStore(database, {migrate:false});
  const store = new ChannelStore(database, {migrate:false});
  try {
    const inbox = new TopicInboxStore(paths.topicInbox);
    const reserved = runtime.withImmediateTransaction(() => reserveInteractiveChannelMessage(database,input,
      timestamp(options),String(inbox.cursor(input.channelRef.channelId))));
    const receipt = reserved.receipt.status === "pending"
      ? await settlePendingChannelSend(repoRoot, reserved.receipt, options) : reserved.receipt;
    const currentFollow = store.requireFollow(receipt.followToken);
    if (receipt.status === "accepted" && currentFollow.status === "waiting") {
      store.commitFollow({followToken:currentFollow.followToken,expectedRevision:currentFollow.revision,
        next:transitionChannelFollow(currentFollow,{status:"active",
          ...(receipt.observedCursor === undefined ? {} : {currentCursor:receipt.observedCursor}),at:receipt.updatedAt})});
    }
    return {outcome:reserved.created ? "applied" as const : "unchanged" as const,
      receipt,follow:store.requireFollow(receipt.followToken)};
  } finally { store.close();runtime.close();database.close(); }
}

export async function settlePendingChannelSend(
  repoRoot: string,
  receipt: ChannelSendReceipt,
  options: ChannelControlOptions = {}
): Promise<ChannelSendReceipt> {
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  const store = new ChannelStore(paths.database);
  try {
    let current = store.requireSend(receipt.sendId);
    if (current.status !== "pending") return current;
    if (current.channelRef.kind === "local-chat") return settleLocalChannelSend(repoRoot,current,options);
    let serverDispatchStarted = false;
    try {
      const binding = store.requireBinding(current.bindingId);
      if (binding.revision !== current.bindingRevision ||
        !interactiveChannelBindingAvailableAt(binding, timestamp(options)) || !channelRefAllowed(binding,current.channelRef)) {
        throw new Error("Interactive Channel binding authority changed before delivery");
      }
      let accepted: ChannelSendReceipt;
      {
        const foundation = new LocalFoundationStore(paths.database);
        const inbox = new TopicInboxStore(paths.topicInbox);
        try {
          const agent = foundation.listAgents().find(
            ({ principalId }) => principalId === current.senderAgentId
          );
          if (agent === undefined || agent.status !== "active") {
            throw new Error("Bound Agent is not active");
          }
          if (inbox.participant(current.channelRef.channelId, current.senderAgentId) === undefined) {
            throw new Error("Bound Agent is not enrolled in Server Topic");
          }
          // Commit intent before network I/O, so response loss/restart never erases
          // the possibility that the remote side effect already occurred.
          if (current.deliveryAttempted !== true) current = store.commitSend({sendId:current.sendId,
            expectedRevision:current.revision,next:markChannelDeliveryAttempted(current,timestamp(options))});
          serverDispatchStarted = true;
          const event = await publishServerTopicMessage(
            repoRoot,
            current.channelRef.channelId,
            agent.handle,
            current.transactionId,
            current.body,
            {
              ...(options.runtimeDirectory === undefined
                ? {} : { runtimeDirectory: options.runtimeDirectory }),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch })
            }
          );
          accepted = acceptChannelSend(current, {
            observedCursor: String(event.sequence),
            remoteMessageId: event.eventId,
            at: timestamp(options)
          });
        } finally {
          foundation.close();
        }
      }
      return store.commitSend({
        sendId: current.sendId,
        expectedRevision: current.revision,
        next: accepted
      });
    } catch (error) {
      if (serverDispatchStarted && !definitiveServerRejection(error)) {
        return store.requireSend(current.sendId);
      }
      const failed = failChannelSend(
        current, error instanceof Error ? error.message : String(error), timestamp(options)
      );
      return store.commitSend({
        sendId: current.sendId,
        expectedRevision: current.revision,
        next: failed
      });
    }
  } finally {
    store.close();
  }
}

function settleLocalChannelSend(repoRoot: string, receipt: ChannelSendReceipt, options: ChannelControlOptions) {
  const database = openRuntimeDatabase(runtimePaths(repoRoot, options.runtimeDirectory).database);
  const store = new ChannelStore(database, { migrate: false });
  const runtime = new RuntimeStore(database, { migrate: false });
  const foundation = new LocalFoundationStore(database, { migrate: false });
  const governance = new TopicGovernanceStore(database);
  const chat = new LocalChatStore(database);
  try {
    return runtime.withImmediateTransaction(() => {
      const current = store.requireSend(receipt.sendId);
      if (current.status !== "pending") return current;
      // Reconcile an old crash gap by exact canonical source, even after revocation.
      // This records an existing effect; it never re-sends under revoked authority.
      const existing = database.prepare(`
        SELECT event_id FROM events WHERE source_kind = 'handler' AND source_external_id = ?
      `).get(current.transactionId) as { event_id: string } | undefined;
      const event = existing === undefined ? undefined : runtime.event(existing.event_id);
      let message = event?.type === "chat.message" ? event : undefined;
      if (message !== undefined && (message.topicId !== current.channelRef.channelId ||
        message.body !== current.body || message.sender.kind !== "agent" ||
        message.sender.principalId !== current.senderAgentId)) {
        throw new Error("Channel canonical message identity mismatch");
      }
      if (message === undefined) {
        const binding = store.requireBinding(current.bindingId);
        const agent = foundation.agent(current.senderAgentId);
        const participant = activeTopicParticipant(governance, current.channelRef.channelId, current.senderAgentId);
        const eligible = binding.revision === current.bindingRevision &&
          interactiveChannelBindingAvailableAt(binding, timestamp(options)) &&
          channelRefAllowed(binding, current.channelRef) && agent?.status === "active" && participant;
        if (!eligible) return store.commitSend({
          sendId: current.sendId, expectedRevision: current.revision,
          next: failChannelSend(current, participant
            ? "Channel authority changed before local delivery"
            : "Agent is not an active Local Topic participant", timestamp(options))
        });
        message = chat.admitExternalAgentMessage({
          source: { kind: "handler", externalId: current.transactionId },
          topicId: current.channelRef.channelId,
          sender: { principalId: current.senderAgentId, handleSnapshot: agent!.handle },
          body: current.body, activation: { strategyId: "participant-message", turnBudget: 8 },
          at: current.createdAt
        }).message;
      }
      return store.commitSend({
        sendId: current.sendId, expectedRevision: current.revision,
        next: acceptChannelSend(current, {
          observedCursor: message.eventId, messageEventId: message.eventId,
          conversationRootId: message.causality.rootEventId, at: timestamp(options)
        })
      });
    });
  } finally {
    chat.close();
    governance.close();
    foundation.close();
    runtime.close();
    store.close();
    database.close();
  }
}

function definitiveServerRejection(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error) ||
    typeof error.status !== "number") return false;
  return error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
}

function activeTopicParticipant(
  store: TopicGovernanceStore,
  topicId: string,
  agentId: string
): boolean {
  const topic = store.require(topicId);
  return topic.status === "active" && topic.participants.some(
    (participant) => participant.agentId === agentId && participant.status === "active"
  );
}

export function stopInteractiveChannelFollow(
  repoRoot: string,
  followToken: string,
  expectedRevision: number,
  options: ChannelControlOptions = {}
) {
  const store = new ChannelStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
  try {
    return stopInteractiveChannelFollowInTransaction(store,followToken,expectedRevision,timestamp(options));
  } finally {
    store.close();
  }
}

export function stopInteractiveChannelFollowInTransaction(store: ChannelStore,followToken: string,
  expectedRevision: number,at: string) {
    const current = store.requireFollow(followToken);
    if (current.revision !== expectedRevision) return { outcome: "conflict" as const, follow: current };
    if (["quiet", "terminal", "failed", "expired", "stopped"].includes(current.status)) {
      return { outcome: "unchanged" as const, follow: current };
    }
    const follow = store.commitFollow({
      followToken,
      expectedRevision,
      next: transitionChannelFollow(current, { status: "stopped", at })
    });
    return { outcome: "applied" as const, follow };
}

function timestamp(options: LocalControlOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}
