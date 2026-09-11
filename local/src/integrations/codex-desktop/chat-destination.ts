import type { CodexPushSourceResolver } from "./push.js";
import type { ChatDispatchEvent, Event } from "../../core/event/model.js";
import { runtimeId, type RuntimeDestination } from "../../core/runtime/model.js";
import type { RuntimeStore } from "../../core/runtime/store.js";
import type { ChatReplyRoute } from "../../core/runtime/store/types.js";

export function codexChatDestination(threadId: string, agentId: string, at: string): RuntimeDestination {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(threadId)) {
    throw new Error("Codex Desktop target requires an exact lowercase task UUID");
  }
  return { destinationId: runtimeId("dst"), kind: "codex-desktop",
    address: { threadId, agentId }, createdAt: at, updatedAt: at };
}

export function resolveCodexChatReplyRoute(store: RuntimeStore, dispatch: ChatDispatchEvent): ChatReplyRoute | undefined {
  const source = dispatch.sourceMessageEventId === undefined ? undefined : store.event(dispatch.sourceMessageEventId);
  if (source?.type !== "chat.message" || source.destinationIds.length === 0) return undefined;
  const destination = store.destinationSnapshots(source.eventId)[0];
  if (destination?.kind !== "codex-desktop") return undefined;
  assertCodexChatSource(source, dispatch, destination);
  return { continueAttention: true, delivery: destination };
}

export function assertCodexChatSource(source: Event | undefined, dispatch: Event | undefined, destination: RuntimeDestination): void {
  const { threadId, agentId } = destination.address;
  if (destination.kind !== "codex-desktop" || Object.keys(destination.address).length !== 2 ||
    threadId === undefined || agentId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(threadId) ||
    source?.type !== "chat.message" || source.source.kind !== "cli" || source.sender.kind !== "owner" ||
    source.destinationIds.length !== 1 || source.destinationIds[0] !== destination.destinationId ||
    source.targets?.length !== 1 || source.targets[0]?.principalId !== agentId ||
    dispatch?.type !== "chat.dispatch" || dispatch.agentId !== agentId ||
    dispatch.sourceMessageEventId !== source.eventId || dispatch.causality.parentEventId !== source.eventId ||
    dispatch.topicId !== source.topicId) {
    throw new Error("Codex Desktop reply does not match the Owner source, Agent and task binding");
  }
}

export function resolveCodexChatPush(store: RuntimeStore, { delivery, destination }: Parameters<CodexPushSourceResolver>[0]): ReturnType<CodexPushSourceResolver> {
  const reply = store.event(delivery.origin.id);
  if (reply === undefined) return undefined;
  const dispatch = reply?.causality.parentEventId === undefined ? undefined : store.event(reply.causality.parentEventId);
  const source = reply?.type !== "chat.message" || reply.replyToEventId === undefined ? undefined : store.event(reply.replyToEventId);
  assertCodexChatSource(source, dispatch, destination);
  const canonical = store.destinationSnapshots(source!.eventId)[0];
  if (canonical?.destinationId !== destination.destinationId || canonical.kind !== destination.kind ||
    canonical.address.threadId !== destination.address.threadId || canonical.address.agentId !== destination.address.agentId) {
    throw new Error("Codex Desktop destination differs from the immutable Owner binding");
  }
  if (reply?.type !== "chat.message" || reply.sender.kind !== "agent" ||
    reply.sender.principalId !== destination.address.agentId || reply.agentId !== destination.address.agentId ||
    reply.topicId !== (source?.type === "chat.message" ? source.topicId : undefined) ||
    reply.body !== delivery.payload.body) throw new Error("Codex Desktop canonical reply identity mismatch");
  return { body: reply.body, source: { kind: "rs-chat-reply", eventId: reply.eventId, requestEventId: source!.eventId,
    agentId: reply.agentId, topicId: reply.topicId } };
}
