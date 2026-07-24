import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addLocalAgent,
  localRuntimeSnapshot,
  suspendLocalAgent
} from "../src/application/local-agent-control.js";
import {
  dispatchLocalChatMessage,
  localChatView,
  postLocalChatMessage,
  promptLocalChatDispatches,
  rotateLocalAgentSession
} from "../src/application/local-chat-control.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { AgentHandler, type RuntimeAgentAdapter } from "../src/core/runtime/handlers.js";
import { startRuntime } from "../src/bootstrap/runtime.js";

test("Local Chat dispatch is immutable, exactly-once and resumes per-Agent Session", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-runtime-"));
  const options = { runtimeDirectory };
  try {
    const alice = addLocalAgent(repo, "Alice", "codex", options);
    const bob = addLocalAgent(repo, "bob", "codex", options);
    const explicit = postLocalChatMessage(repo, "please inspect this @alice", options);
    assert.equal(explicit.message.type, "chat.message");
    assert.deepEqual(explicit.message.target, {
      principalId: alice.principalId,
      handleSnapshot: "Alice"
    });
    assert.equal(explicit.dispatch?.event.type, "chat.dispatch");
    assert.equal(explicit.dispatch?.event.agentId, alice.principalId);

    const duplicate = dispatchLocalChatMessage(
      repo,
      explicit.message.eventId,
      bob.principalId,
      options
    );
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.event.eventId, explicit.dispatch?.event.eventId);
    assert.equal(duplicate.event.agentId, alice.principalId);

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
            outcome: { kind: "message", body: "inspection complete" }
          };
        }
      };
      const handler = new AgentHandler({
        store: runtime,
        adapters: new Map([[alice.principalId, adapter]])
      });
      const firstExecution = runtime.claimDueExecutions()[0]!;
      const reply = await handler.handle(firstExecution);
      assert.equal(reply?.type, "chat.message");
      assert.equal(reply?.sender.kind, "agent");
      assert.equal(reply?.body, "inspection complete");
      assert.equal(runtime.events().filter((event) => event.type === "agent.result").length, 0);

      const current = localChatView(repo, options).sessions.find(
        ({ principalId }) => principalId === alice.principalId
      );
      assert.ok(current?.currentSessionId !== undefined);

      const followUp = postLocalChatMessage(repo, "@Alice continue", options);
      assert.equal(followUp.dispatch?.event.sessionId, current.currentSessionId);
      const secondExecution = runtime.claimDueExecutions()[0]!;
      await handler.handle(secondExecution);
      assert.equal(invoked[1]?.providerSessionId, "provider-alice-1");

      assert.equal(rotateLocalAgentSession(repo, alice.principalId, options), 2);
      const afterRotate = postLocalChatMessage(repo, "@alice start fresh", options);
      assert.equal(afterRotate.dispatch?.event.sessionId, undefined);
      postLocalChatMessage(repo, "@alice queued before fresh Session exists", options);
      const [freshExecution, queuedExecution] = runtime.claimDueExecutions();
      assert.ok(freshExecution);
      assert.ok(queuedExecution);
      const freshReply = await handler.handle(freshExecution);
      const queuedReply = await handler.handle(queuedExecution);
      assert.equal(freshReply?.type, "chat.message");
      assert.equal(queuedReply?.type, "chat.message");
      assert.equal(freshReply?.sessionId, queuedReply?.sessionId);
      assert.equal(invoked.at(-1)?.providerSessionId, "provider-alice-2");
    } finally {
      runtime.close();
    }

    const plain = postLocalChatMessage(repo, "somebody take this", options);
    assert.equal(plain.dispatch, undefined);
    assert.equal(promptLocalChatDispatches(repo, options).length, 1);
    assert.equal(promptLocalChatDispatches(repo, options).length, 0);
    const card = localChatView(repo, options).events.find(
      (event) => event.type === "chat.message" &&
        event.dispatchCard?.sourceMessageEventId === plain.message.eventId
    );
    assert.equal(card?.type, "chat.message");
    assert.deepEqual(
      card?.dispatchCard?.candidates.map(({ handle }) => handle),
      ["Alice", "bob"]
    );

    suspendLocalAgent(repo, bob.principalId, options);
    const nextPlain = postLocalChatMessage(repo, "another task", options);
    promptLocalChatDispatches(repo, options);
    const nextCard = localChatView(repo, options).events.find(
      (event) => event.type === "chat.message" &&
        event.dispatchCard?.sourceMessageEventId === nextPlain.message.eventId
    );
    assert.equal(nextCard?.type, "chat.message");
    if (nextCard?.type !== "chat.message") throw new Error("dispatch card is missing");
    assert.deepEqual(
      nextCard.dispatchCard?.candidates.map(({ handle }) => handle),
      ["Alice"]
    );
    assert.throws(
      () => dispatchLocalChatMessage(repo, nextPlain.message.eventId, bob.principalId, options),
      /Active Local Agent not found/
    );

    const restarted = localChatView(repo, options);
    assert.equal(restarted.chat.handle, "local");
    assert.ok(restarted.events.some(
      (event) => event.type === "chat.dispatch" &&
        event.eventId === explicit.dispatch?.event.eventId
    ));
    assert.equal(localRuntimeSnapshot(repo, options).foundation.topicId, restarted.chat.topicId);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("foreground Local loop appends dispatch prompts for unmentioned messages", async () => {
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
    const prompt = localChatView(repo, options).events.find(
      (event) => event.type === "chat.message" &&
        event.dispatchCard?.sourceMessageEventId === pending.message.eventId
    );
    assert.equal(prompt?.type, "chat.message");
    assert.deepEqual(prompt?.dispatchCard?.candidates, []);
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
      const silentExecution = runtime.claimDueExecutions()[0]!;
      assert.equal(await handler.handle(silentExecution), undefined);
      assert.equal(runtime.execution(silentExecution.executionId)?.status, "succeeded");
      assert.equal(runtime.events().filter((event) => event.type === "agent.result").length, 0);

      postLocalChatMessage(repo, "@worker fail", options);
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
