import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addLocalAgent,
  localRuntimeSnapshot,
} from "../src/application/agent/control.js";
import {
  localChatView,
  postLocalChatMessage,
  rotateLocalAgentSession
} from "../src/application/chat/control.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import type { LocalAgent } from "../src/modules/foundation/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import { AgentHandler, type RuntimeAgentAdapter } from "../src/core/runtime/handlers.js";
import { startRuntime } from "../src/bootstrap/runtime.js";

test("Local Chat autonomously dispatches a mention and resumes the per-Agent Session", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-runtime-"));
  const options = { runtimeDirectory };
  try {
    const alice = addLocalAgent(repo, "Alice", "codex", options);
    const explicit = postLocalChatMessage(repo, "please inspect this @alice", options);
    assert.equal(explicit.message.type, "chat.message");
    assert.deepEqual(explicit.message.target, {
      principalId: alice.principalId,
      handleSnapshot: "Alice"
    });
    assert.equal(explicit.dispatch, undefined);

    const invoked: Array<{ providerSessionId?: string; body: string }> = [];
    let nextProviderSession = 1;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      const adapter: RuntimeAgentAdapter = {
        adapterId: "fake-local-agent",
        workspace: join(runtimeDirectory, "workspace"),
        async invoke(input) {
          invoked.push({
            ...(input.providerSessionId === undefined
              ? {}
              : { providerSessionId: input.providerSessionId }),
            body: input.event.prompt
          });
          return {
            providerSessionId: input.providerSessionId ??
              `provider-alice-${nextProviderSession++}`,
            outcome: {
              kind: "message",
              body: decision("reply", "inspection complete")
            }
          };
        }
      };
      const handler = new AgentHandler({
        store: runtime,
        adapters: new Map([[alice.principalId, adapter]])
      });
      dispatchNextMessage(runtime, [alice], runtimeDirectory);
      const firstExecution = runtime.claimDueExecutions()[0]!;
      const reply = await handler.handle(firstExecution);
      assert.equal(reply?.type, "chat.message");
      assert.equal(reply?.sender.kind, "agent");
      assert.equal(reply?.body, "inspection complete");
      assert.equal(runtime.events().filter((event) => event.type === "agent.result").length, 0);
      dispatchNextMessage(runtime, [alice], runtimeDirectory);

      const current = localChatView(repo, options).sessions.find(
        ({ principalId }) => principalId === alice.principalId
      );
      assert.ok(current?.currentSessionId !== undefined);

      postLocalChatMessage(repo, "@Alice continue", options);
      dispatchNextMessage(runtime, [alice], runtimeDirectory);
      const secondExecution = runtime.claimDueExecutions()[0]!;
      assert.equal(runtime.event(secondExecution.eventId)?.sessionId, current.currentSessionId);
      await handler.handle(secondExecution);
      assert.equal(invoked[1]?.providerSessionId, "provider-alice-1");
      dispatchNextMessage(runtime, [alice], runtimeDirectory);

      assert.equal(rotateLocalAgentSession(repo, alice.principalId, options), 2);
      postLocalChatMessage(repo, "@alice start fresh", options);
      dispatchNextMessage(runtime, [alice], runtimeDirectory);
      const freshExecution = runtime.claimDueExecutions()[0]!;
      assert.equal(runtime.event(freshExecution.eventId)?.sessionId, undefined);
      const freshReply = await handler.handle(freshExecution);
      dispatchNextMessage(runtime, [alice], runtimeDirectory);

      postLocalChatMessage(repo, "@alice queued before fresh Session exists", options);
      dispatchNextMessage(runtime, [alice], runtimeDirectory);
      const queuedExecution = runtime.claimDueExecutions()[0]!;
      assert.ok(queuedExecution);
      const queuedReply = await handler.handle(queuedExecution);
      assert.equal(freshReply?.type, "chat.message");
      assert.equal(queuedReply?.type, "chat.message");
      assert.equal(freshReply?.sessionId, queuedReply?.sessionId);
      assert.equal(invoked.at(-1)?.providerSessionId, "provider-alice-2");
      assert.equal(
        runtime.chatAttentionReceipts(explicit.message.eventId)[0]?.outcome,
        "dispatched"
      );
    } finally {
      runtime.close();
    }

    const restarted = localChatView(repo, options);
    assert.equal(restarted.chat.handle, "local");
    assert.ok(restarted.events.some(
      (event) => event.type === "chat.dispatch" &&
        event.sourceMessageEventId === explicit.message.eventId
    ));
    assert.equal(localRuntimeSnapshot(repo, options).foundation.topicId, restarted.chat.topicId);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("foreground Local loop completes an unmentioned message without legacy dispatch cards", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-loop-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-loop-runtime-"));
  const options = { runtimeDirectory };
  const controller = new AbortController();
  try {
    const pending = postLocalChatMessage(repo, "route this later", options);
    const stop = setTimeout(() => controller.abort(), 80);
    try {
      await startRuntime({
        repoRoot: repo,
        runtimeDirectory,
        environment: { HOME: repo, PATH: "/usr/bin:/bin" },
        pollMilliseconds: 50
      }, controller.signal);
    } finally {
      clearTimeout(stop);
    }
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      assert.equal(runtime.executionForEvent(pending.message.eventId)?.status, "succeeded");
      assert.deepEqual(runtime.chatAttentionReceipts(pending.message.eventId), []);
    } finally {
      runtime.close();
    }
    assert.ok(!localChatView(repo, options).events.some(
      (event) => event.type === "chat.message" && event.dispatchCard !== undefined
    ));
  } finally {
    controller.abort();
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("silent and failed Local Agent outcomes terminate without agent.result relay", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-outcome-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-outcome-runtime-"));
  const options = { runtimeDirectory };
  try {
    const agent = addLocalAgent(repo, "worker", "codex", options);
    postLocalChatMessage(repo, "@worker stay silent", options);
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      const handler = new AgentHandler({
        store: runtime,
        adapters: new Map([[agent.principalId, {
          adapterId: "silent-agent",
          workspace: join(runtimeDirectory, "workspace"),
          async invoke() {
            return { providerSessionId: "silent-session", outcome: { kind: "silent" } };
          }
        }]])
      });
      dispatchNextMessage(runtime, [agent], runtimeDirectory);
      const silentExecution = runtime.claimDueExecutions()[0]!;
      assert.equal(await handler.handle(silentExecution), undefined);
      assert.equal(runtime.execution(silentExecution.executionId)?.status, "succeeded");
      assert.equal(runtime.events().filter((event) => event.type === "agent.result").length, 0);

      postLocalChatMessage(repo, "@worker fail", options);
      dispatchNextMessage(
        runtime,
        [agent],
        runtimeDirectory,
        "2099-07-23T12:00:00.000Z"
      );
      let execution = runtime.claimDueExecutions(1, "2099-07-23T12:00:00.000Z")[0]!;
      let failed = runtime.failExecution(
        execution.executionId,
        "provider unavailable",
        "2099-07-23T12:00:00.000Z",
        1
      );
      execution = runtime.claimDueExecutions(1, "2099-07-23T12:00:01.000Z")[0]!;
      failed = runtime.failExecution(
        execution.executionId,
        "provider unavailable",
        "2099-07-23T12:00:01.000Z",
        1
      );
      execution = runtime.claimDueExecutions(1, "2099-07-23T12:00:02.000Z")[0]!;
      failed = runtime.failExecution(
        execution.executionId,
        "provider unavailable",
        "2099-07-23T12:00:02.000Z",
        1
      );
      assert.equal(failed.execution.status, "failed");
      assert.equal(failed.resultEvent, undefined);
      assert.equal(runtime.events().filter((event) => event.type === "agent.result").length, 0);
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function dispatchNextMessage(
  runtime: RuntimeStore,
  agents: readonly LocalAgent[],
  runtimeDirectory: string,
  at = new Date().toISOString()
): void {
  const execution = runtime.claimDueExecutions(1, at)[0];
  assert.ok(execution);
  assert.equal(execution.handler, "chat");
  const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
  try {
    new ChatHandler({
      store: runtime,
      chat,
      listAgents: () => agents
    }).handle(execution, at);
  } finally {
    chat.close();
  }
}

function decision(action: "reply" | "silent", body?: string): string {
  return JSON.stringify({
    schema: "ChatMentionDecision@1",
    speech: action === "reply" ? { action, body } : { action }
  });
}
