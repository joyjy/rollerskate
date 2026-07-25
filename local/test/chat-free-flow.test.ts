import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChatHandler } from "../src/application/chat/handler.js";
import { addLocalAgent, localRuntimeSnapshot } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import {
  boundedChatPromptHistory,
  chatTimelineFromStore
} from "../src/application/chat/query.js";
import { chatMentionPromptResourceId } from "../src/core/chat/model.js";
import { RuntimeCycle } from "../src/core/runtime/cycle.js";
import {
  AgentHandler,
  DeliveryHandler,
  ResultHandler,
  type RuntimeAgentAdapter,
  type RuntimeEventHandler
} from "../src/core/runtime/handlers.js";
import type { RuntimeHandlerKind } from "../src/core/runtime/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";

test("Free Chat runs reply, silence, scoped snooze, deterministic wake, and Session resume end to end",
  async () => {
    const repo = mkdtempSync(join(tmpdir(), "rollerskate-free-chat-repo-"));
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-free-chat-runtime-"));
    const options = { runtimeDirectory };
    try {
      const alice = addLocalAgent(repo, "alice", "codex", options);
      const bob = addLocalAgent(repo, "bob", "codex", options);
      const agents = localRuntimeSnapshot(repo, options).agents;
      const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
      const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
      const invocations = new Map<string, Array<string | undefined>>([
        [alice.principalId, []],
        [bob.principalId, []]
      ]);
      try {
        const adapters = new Map<string, RuntimeAgentAdapter>(agents.map((agent) => [
          agent.principalId,
          {
            adapterId: `fake-${agent.handle}`,
            workspace: join(runtimeDirectory, "workspace"),
            async invoke(input) {
              invocations.get(agent.principalId)!.push(input.providerSessionId);
              if (input.event.type !== "chat.dispatch") {
                throw new Error("fixture only accepts chat.dispatch");
              }
              const source = runtime.event(input.event.sourceMessageEventId);
              if (source?.type !== "chat.message") throw new Error("source missing");
              const aliceFirst = agent.principalId === alice.principalId &&
                source.body === "Who can inspect the release?";
              const afterExpiry = source.body === "A fresh topic after expiry";
              const mentioned = input.event.promptResourceId === chatMentionPromptResourceId;
              return {
                providerSessionId: input.providerSessionId ?? `${agent.handle}-provider`,
                outcome: {
                  kind: "message" as const,
                  body: JSON.stringify(mentioned
                    ? {
                        schema: "ChatMentionDecision@1",
                        speech: { action: "silent" }
                      }
                    : {
                        schema: "ChatDecision@1",
                        speech: aliceFirst
                          ? { action: "reply", body: "I can inspect it." }
                          : { action: "silent" },
                        presence: agent.principalId === alice.principalId && !afterExpiry
                          ? {
                              scope: "global",
                              mode: "snoozed",
                              until: "2026-07-25T13:00:00.000Z",
                              wakeKeywords: ["urgent"]
                            }
                          : {
                              scope: "topic",
                              mode: "available",
                              wakeKeywords: []
                            }
                      })
                }
              };
            }
          }
        ]));
        const cycle = new RuntimeCycle({
          store: runtime,
          handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
            ["chat", new ChatHandler({ store: runtime, chat, listAgents: () => agents })],
            ["agent", new AgentHandler({ store: runtime, adapters })],
            ["result", new ResultHandler(runtime)]
          ]),
          deliveryHandler: new DeliveryHandler({ store: runtime, adapters: new Map() })
        });

        const first = postAt(repo, "Who can inspect the release?", options,
          "2026-07-25T12:00:00.000Z");
        assert.deepEqual((await cycle.run("2026-07-25T12:00:00.000Z")).failures, []);
        assert.equal(runtime.chatAttentionReceipts(first.eventId).length, 2);
        assert.ok(runtime.chatMessages(first.topicId).some(
          (message) => message.sender.principalId === alice.principalId &&
            message.body === "I can inspect it."
        ));
        assert.equal(runtime.chatPresence(alice.principalId, first.topicId).global?.mode,
          "snoozed");

        const ordinary = postAt(repo, "Here is more context", options,
          "2026-07-25T12:05:00.000Z");
        await cycle.run("2026-07-25T12:05:00.000Z");
        assert.equal(receipt(runtime, ordinary.eventId, alice.principalId).reason,
          "global-snoozed");

        const keyword = postAt(repo, "URGENT: please look again", options,
          "2026-07-25T12:10:00.000Z");
        await cycle.run("2026-07-25T12:10:00.000Z");
        assert.equal(receipt(runtime, keyword.eventId, alice.principalId).reason,
          "global-wake-keyword");

        const mention = postAt(repo, "@alice one direct question", options,
          "2026-07-25T12:20:00.000Z");
        await cycle.run("2026-07-25T12:20:00.000Z");
        assert.equal(receipt(runtime, mention.eventId, alice.principalId).reason,
          "direct-mention");
        assert.equal(receipt(runtime, mention.eventId, bob.principalId).reason,
          "not-target");
        assert.equal(receipt(runtime, mention.eventId, alice.principalId).promptResourceId,
          chatMentionPromptResourceId);
        assert.equal(runtime.chatPresence(alice.principalId, first.topicId).global?.mode,
          "snoozed");
        const mentionDispatchId = receipt(
          runtime,
          mention.eventId,
          alice.principalId
        ).dispatchEventId!;
        assert.equal(
          runtime.chatDecisionReceipt(mentionDispatchId)?.presenceTransition,
          undefined
        );

        const expired = postAt(repo, "A fresh topic after expiry", options,
          "2026-07-25T14:00:00.000Z");
        await cycle.run("2026-07-25T14:00:00.000Z");
        assert.equal(receipt(runtime, expired.eventId, alice.principalId).reason,
          "available");
        assert.equal(runtime.chatPresence(alice.principalId, first.topicId).topic?.mode,
          "available");
        assert.ok(invocations.get(alice.principalId)!.slice(1).every(
          (providerSessionId) => providerSessionId === "alice-provider"
        ));

        const firstDispatch = runtime.chatAttentionReceipts(first.eventId)
          .find((item) => item.agentId === alice.principalId)!;
        const audit = runtime.audit(firstDispatch.dispatchEventId!);
        assert.equal(audit?.chat?.promptResourceId, "prompt.chat.free-turn");
        assert.equal(audit?.chat?.attentionReceipts[0]?.sourceMessageEventId, first.eventId);
        assert.equal(audit?.chat?.decisionReceipt?.speechAction, "reply");
      } finally {
        chat.close();
        runtime.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  });

test("Chat Agent recalls bounded earlier pages in the same Session without new recall Events",
  async () => {
    const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-recall-repo-"));
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-recall-runtime-"));
    const options = { runtimeDirectory };
    const at = "2026-07-25T12:00:00.000Z";
    try {
      const alice = addLocalAgent(repo, "alice", "codex", options);
      const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
      const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
      try {
        for (let index = 0; index < 55; index += 1) {
          chat.postOwnerMessage({
            topicId: localRuntimeSnapshot(repo, options).foundation.topicId,
            ownerPrincipalId: "owner-history",
            body: `historical-${index}`,
            at: "2026-07-25T11:00:00.000Z"
          });
        }
        const historyExecutions = runtime.claimDueExecutions(100, at);
        const noAgentChat = new ChatHandler({
          store: runtime,
          chat,
          listAgents: () => []
        });
        for (const execution of historyExecutions) noAgentChat.handle(execution, at);

        const source = postAt(repo, "@alice recall the oldest context", options, at);
        const sourceExecution = runtime.claimDueExecutions(1, at)[0]!;
        new ChatHandler({
          store: runtime,
          chat,
          listAgents: () => [alice]
        }).handle(sourceExecution, at);
        const dispatchExecution = runtime.claimDueExecutions(1, at)[0]!;
        const initialHistory = boundedChatPromptHistory(chatTimelineFromStore(
          chat,
          source.topicId,
          { beforeEventId: source.eventId, limit: 50 }
        ));
        assert.equal(initialHistory.hasEarlier, true);
        assert.ok(initialHistory.beforeEventId);

        const invocations: Array<{
          readonly providerSessionId?: string;
          readonly prompt: string;
        }> = [];
        const adapter: RuntimeAgentAdapter = {
          adapterId: "recall-agent",
          workspace: join(runtimeDirectory, "workspace"),
          async invoke(input) {
            invocations.push({
              ...(input.providerSessionId === undefined
                ? {}
                : { providerSessionId: input.providerSessionId }),
              prompt: input.event.prompt
            });
            return invocations.length === 1
              ? {
                  providerSessionId: "provider-recall",
                  outcome: {
                    kind: "message",
                    body: JSON.stringify({
                      schema: "ChatHistoryRequest@1",
                      beforeEventId: initialHistory.beforeEventId,
                      limit: 50
                    })
                  }
                }
              : {
                  providerSessionId: "provider-recall",
                  outcome: {
                    kind: "message",
                    body: JSON.stringify({
                      schema: "ChatMentionDecision@1",
                      speech: { action: "reply", body: "I found the older context." }
                    })
                  }
                };
          }
        };
        const eventsBefore = runtime.events().length;
        const handler = new AgentHandler({
          store: runtime,
          adapters: new Map([[alice.principalId, adapter]]),
          chatHistory: ({ topicId, beforeEventId, limit }) =>
            boundedChatPromptHistory(chatTimelineFromStore(chat, topicId, {
              beforeEventId,
              limit
            }))
        });
        const reply = await handler.handle(dispatchExecution, at);

        assert.equal(invocations.length, 2);
        assert.equal(invocations[1]?.providerSessionId, "provider-recall");
        assert.match(invocations[1]?.prompt ?? "", /historical-0/u);
        assert.equal(reply?.type, "chat.message");
        assert.equal(reply?.body, "I found the older context.");
        assert.equal(runtime.events().length, eventsBefore + 1);
        assert.equal(runtime.events().filter((event) => event.type === "agent.result").length, 0);
      } finally {
        chat.close();
        runtime.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  });

function postAt(
  repo: string,
  body: string,
  options: { readonly runtimeDirectory: string },
  at: string
) {
  return postLocalChatMessage(repo, body, {
    ...options,
    now: () => new Date(at)
  }).message;
}

function receipt(runtime: RuntimeStore, eventId: string, agentId: string) {
  const found = runtime.chatAttentionReceipts(eventId).find(
    (item) => item.agentId === agentId
  );
  assert.ok(found);
  return found;
}
