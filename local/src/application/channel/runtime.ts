import { RuntimeStore } from "../../core/runtime/store.js";
import { TopicInboxStore } from "../../infrastructure/files/topic-inbox-store.js";
import { ChannelStore } from "../../infrastructure/sqlite/channel-store.js";
import { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  transitionChannelCallback,
  transitionChannelFollow,
  transitionInteractiveChannelBinding,
  touchChannelFollow,
  type ChannelFollow
} from "../../modules/channel/model.js";
import {
  settlePendingChannelSend,
  type ChannelControlOptions
} from "./control.js";

export interface InteractiveChannelCycle {
  readonly settledSendIds: readonly string[];
  readonly advancedFollowTokens: readonly string[];
  readonly admittedCallbackEventIds: readonly string[];
}

export class InteractiveChannelRuntime {
  readonly #chat: LocalChatStore;
  readonly #inbox: TopicInboxStore;
  readonly #foundation: LocalFoundationStore;
  readonly #options: ChannelControlOptions;
  readonly #repoRoot: string;
  readonly #runtime: RuntimeStore;
  readonly #store: ChannelStore;

  public constructor(repoRoot: string, options: ChannelControlOptions = {}) {
    const paths = runtimePaths(repoRoot, options.runtimeDirectory);
    this.#repoRoot = repoRoot;
    this.#options = options;
    this.#runtime = new RuntimeStore(paths.database);
    this.#store = new ChannelStore(paths.database);
    this.#chat = new LocalChatStore(paths.database);
    this.#foundation = new LocalFoundationStore(paths.database);
    this.#inbox = new TopicInboxStore(paths.topicInbox);
  }

  public close(): void {
    this.#chat.close();
    this.#foundation.close();
    this.#store.close();
    this.#runtime.close();
  }

  public async runCycle(at = new Date().toISOString()): Promise<InteractiveChannelCycle> {
    const settledSendIds: string[] = [];
    const advancedFollowTokens: string[] = [];
    const admittedCallbackEventIds: string[] = [];
    for (const binding of this.#store.activeBindingsExpiredAt(at)) {
      try {
        this.#store.commitBinding({
          bindingId: binding.bindingId,
          expectedRevision: binding.revision,
          next: transitionInteractiveChannelBinding(binding, "expired", at)
        });
      } catch {
        // A concurrent control transition owns the current revision.
      }
    }
    for (const pending of this.#store.pendingSends()) {
      const settled = await settlePendingChannelSend(this.#repoRoot, pending, {
        ...(this.#options.runtimeDirectory === undefined
          ? {} : { runtimeDirectory: this.#options.runtimeDirectory }),
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        now: () => new Date(at)
      });
      if (settled.status !== "pending") settledSendIds.push(settled.sendId);
    }
    for (const initial of this.#store.activeFollows()) {
      const reconciled = this.#reconcileFollow(initial, at);
      const next = reconciled ?? touchChannelFollow(initial, at);
      try {
        this.#store.commitFollow({
          followToken: initial.followToken,
          expectedRevision: initial.revision,
          next
        });
        if (reconciled !== undefined) advancedFollowTokens.push(initial.followToken);
      } catch {
        // A concurrent follow/stop owns the current revision.
      }
    }
    for (const initial of this.#store.callbackCandidates()) {
      const callback = initial.callback;
      if (callback === undefined || callback.status === "admitted" ||
        callback.status === "failed" || callback.status === "expired" ||
        callback.status === "revoked") continue;
      const binding = this.#store.requireBinding(initial.bindingId);
      let next: ChannelFollow;
      if (binding.revision !== initial.bindingRevision || binding.status !== "active") {
        next = transitionChannelCallback(initial, {
          ...callback,
          status: binding.status === "revoked" ? "revoked" : "expired",
          updatedAt: at
        }, at);
      } else if (Date.parse(binding.expiresAt) <= Date.parse(at)) {
        next = transitionChannelCallback(initial, {
          ...callback, status: "expired", updatedAt: at
        }, at);
      } else {
        const agent = this.#foundation.listAgents().find(
          ({ principalId }) => principalId === binding.agentId
        );
        const session = this.#runtime.session(callback.sessionId);
        if (agent === undefined || agent.status !== "active") {
          next = transitionChannelCallback(initial, {
            ...callback,
            status: "failed",
            failure: "binding-agent-inactive",
            updatedAt: at
          }, at);
        } else if (session === undefined || session.agentId !== binding.agentId) {
          next = transitionChannelCallback(initial, {
            ...callback,
            status: "failed",
            failure: "callback-session-ownership-changed",
            updatedAt: at
          }, at);
        } else if (!this.#runtime.sessionIsIdle(callback.sessionId)) {
          if (callback.status === "pending") continue;
          next = transitionChannelCallback(initial, {
            ...callback, status: "pending", updatedAt: at
          }, at);
        } else {
          const admitted = this.#runtime.appendEvent({
            type: "agent.request",
            source: {
              kind: "handler",
              externalId: `channel-follow:${initial.followToken}`
            },
            agentId: binding.agentId,
            sessionId: callback.sessionId,
            prompt: callbackPrompt(initial),
            createdAt: at,
            maxAttempts: 1
          });
          next = transitionChannelCallback(initial, {
            ...callback,
            status: "admitted",
            callbackEventId: admitted.event.eventId,
            updatedAt: at
          }, at);
          admittedCallbackEventIds.push(admitted.event.eventId);
        }
      }
      try {
        this.#store.commitFollow({
          followToken: initial.followToken,
          expectedRevision: initial.revision,
          next
        });
      } catch {
        // Idempotent callback Event remains recoverable by its external ID.
      }
    }
    return { settledSendIds, advancedFollowTokens, admittedCallbackEventIds };
  }

  #reconcileFollow(current: ChannelFollow, at: string): ChannelFollow | undefined {
    const send = this.#store.requireSend(current.sendId);
    if (send.status === "failed") {
      return transitionChannelFollow(current, {
        status: "failed", failure: send.failure ?? "channel-send-failed", at
      });
    }
    if (send.status === "pending") return undefined;
    if (Date.parse(current.deadlineAt) <= Date.parse(at)) {
      return transitionChannelFollow(current, { status: "expired", at });
    }
    if (current.status === "waiting") {
      return transitionChannelFollow(current, {
        status: "active",
        ...(send.observedCursor === undefined ? {} : { currentCursor: send.observedCursor }),
        at
      });
    }
    const cursor = current.currentCursor ?? current.afterCursor;
    const observed = current.channelRef.kind === "local-chat"
      ? this.#localEventsAfter(
          current.channelRef.channelId, cursor, send.senderAgentId
        )
      : this.#serverEventsAfter(current.channelRef.channelId, cursor);
    if (observed.length > 0) {
      const latestCursor = observed.at(-1)!.cursor;
      if (current.condition === "first_reply") {
        const correlated = send.conversationRootId === undefined
          ? []
          : observed.filter(({ rootEventId }) => rootEventId === send.conversationRootId);
        if (correlated.length === 0) {
          return transitionChannelFollow(current, {
            status: "active", currentCursor: latestCursor, at
          });
        }
        return transitionChannelFollow(current, {
          status: "terminal", currentCursor: correlated.at(-1)!.cursor, at
        });
      }
      return transitionChannelFollow(current, {
        status: "active", currentCursor: latestCursor, at
      });
    }
    if (current.condition === "terminal" && send.conversationRootId !== undefined &&
      !this.#rootIsActive(send.conversationRootId)) {
      return transitionChannelFollow(current, { status: "terminal", at });
    }
    if (current.condition === "quiet" &&
      Date.parse(at) - Date.parse(current.lastObservedAt) >= current.quietWindowMilliseconds) {
      return transitionChannelFollow(current, { status: "quiet", at });
    }
    return undefined;
  }

  #localEventsAfter(topicId: string, cursor: string | undefined, senderAgentId: string) {
    const events = cursor === undefined
      ? this.#chat.events(topicId, 200)
      : this.#chat.eventsAfter(topicId, cursor, 200);
    return events
      .filter((event) => event.type === "chat.message" &&
        (event.sender.kind === "owner" ||
          (event.sender.kind === "agent" && event.sender.principalId !== senderAgentId)))
      .slice(0, 100)
      .map(({ eventId, causality }) => ({
        cursor: eventId,
        rootEventId: causality.rootEventId
      }));
  }

  #serverEventsAfter(topicId: string, cursor: string | undefined) {
    const sequence = cursor === undefined ? 0 : Number(cursor);
    const entry = this.#inbox.topics().find(({ topic }) => topic.id === topicId);
    return (entry?.events ?? [])
      .filter((event) => event.sequence > sequence)
      .slice(0, 100)
      .map((event) => ({ cursor: String(event.sequence), rootEventId: undefined }));
  }

  #rootIsActive(rootEventId: string): boolean {
    return this.#runtime.eventsForRoot(rootEventId).some(({ eventId }) => {
      const execution = this.#runtime.executionForEvent(eventId);
      return execution !== undefined &&
        (execution.status === "queued" || execution.status === "running" ||
          execution.status === "retry_wait");
    });
  }

}

function callbackPrompt(follow: ChannelFollow): string {
  return [
    "Interactive Channel follow completed.",
    `Channel: ${follow.channelRef.kind}:${follow.channelRef.channelId}`,
    `Condition: ${follow.condition}`,
    `Status: ${follow.status}`,
    `Follow token: ${follow.followToken}`,
    "Inspect the durable follow by token if more context is needed."
  ].join("\n");
}
