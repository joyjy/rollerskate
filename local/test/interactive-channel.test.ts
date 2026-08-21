import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addLocalAgent, localRuntimeSnapshot } from
  "../src/application/agent/control.js";
import { suspendLocalAgent } from "../src/application/agent/control.js";
import {
  bindInteractiveChannel,
  sendInteractiveChannelMessage
} from "../src/application/channel/control.js";
import { inspectInteractiveChannelFollow } from
  "../src/application/channel/query.js";
import { followInteractiveChannel } from
  "../src/application/channel/query.js";
import { removeLocalTopicParticipant } from
  "../src/application/topic/governance-control.js";
import { InteractiveChannelRuntime } from
  "../src/application/channel/runtime.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import { AgentCredentialStore } from
  "../src/infrastructure/files/agent-credential-store.js";
import { DeviceCredentialStore } from
  "../src/infrastructure/files/device-credential-store.js";
import { TopicInboxStore } from "../src/infrastructure/files/topic-inbox-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { createChannelFollow } from "../src/modules/channel/model.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";

test("exact Agent Local Channel send is idempotent and callback enters the bound idle Session", async () => {
  const fixture = runtimeFixture("local-idempotent");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    const sessionId = createIdleSession(runtime, agent.principalId, fixture.repo);
    const topicId = localRuntimeSnapshot(fixture.repo, fixture.options).foundation.topicId;
    const binding = bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      callbackSessionId: sessionId,
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT));
    const first = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "local-chat", channelId: topicId },
      idempotencyKey: "send-once",
      body: "A durable participant message.",
      followCondition: "quiet",
      quietWindowMilliseconds: 0
    }, fixture.optionsAt("2026-08-03T00:01:00.000Z"));
    const replay = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "local-chat", channelId: topicId },
      idempotencyKey: "send-once",
      body: "A durable participant message.",
      followCondition: "quiet",
      quietWindowMilliseconds: 0
    }, fixture.optionsAt("2026-08-03T00:01:01.000Z"));
    assert.equal(first.receipt.status, "accepted");
    assert.equal(replay.outcome, "unchanged");
    assert.equal(replay.receipt.sendId, first.receipt.sendId);
    await assert.rejects(() => sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "local-chat", channelId: topicId },
      idempotencyKey: "send-once",
      body: "A durable participant message.",
      followCondition: "quiet",
      quietWindowMilliseconds: 1
    }, fixture.optionsAt("2026-08-03T00:01:02.000Z")), /different input/);
    const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
    try {
      assert.equal(chat.events(topicId).filter((event) =>
        event.type === "chat.message" && event.body === "A durable participant message."
      ).length, 1);
    } finally {
      chat.close();
    }
    const channelRuntime = new InteractiveChannelRuntime(fixture.repo, fixture.options);
    try {
      const cycle = await channelRuntime.runCycle("2026-08-03T00:01:02.000Z");
      assert.equal(
        cycle.admittedCallbackEventIds.length,
        1,
        JSON.stringify(inspectInteractiveChannelFollow(
          fixture.repo, first.receipt.followToken, fixture.runtime
        ))
      );
      const callback = runtime.event(cycle.admittedCallbackEventIds[0]!);
      assert.equal(callback?.type, "agent.request");
      assert.equal(callback?.sessionId, sessionId);
      assert.equal(callback?.agentId, agent.principalId);
    } finally {
      channelRuntime.close();
    }
    const follow = inspectInteractiveChannelFollow(
      fixture.repo, first.receipt.followToken, fixture.runtime
    ).follow;
    assert.equal(follow.status, "quiet");
    assert.equal(follow.callback?.status, "admitted");
    runtime.close();
  } finally {
    fixture.close();
  }
});

test("binding rejects a Session owned by another Agent and Server follow rejects false correlation", () => {
  const fixture = runtimeFixture("authority");
  try {
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const bob = addLocalAgent(fixture.repo, "bob", "kimi-code", fixture.optionsAt(AT));
    const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    const bobSession = createIdleSession(runtime, bob.principalId, fixture.repo);
    const topicId = localRuntimeSnapshot(fixture.repo, fixture.options).foundation.topicId;
    assert.throws(() => bindInteractiveChannel(fixture.repo, {
      agentId: alice.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      callbackSessionId: bobSession,
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT)), /belong to the bound Agent/);
    assert.throws(() => createChannelFollow({
      followToken: "fol_00000000-0000-7000-8000-000000000000",
      sendId: "snd_00000000-0000-7000-8000-000000000000",
      bindingId: "chn_00000000-0000-7000-8000-000000000000",
      bindingRevision: 1,
      channelRef: { kind: "server-topic", channelId: "topic-server" },
      condition: "first_reply",
      quietWindowMilliseconds: 1_000,
      deadlineAt: "2026-08-03T01:00:00.000Z"
    }, AT), /cannot claim first_reply or terminal/);
    runtime.close();
  } finally {
    fixture.close();
  }
});

test("Channel callback remains pending while the exact Session is busy", async () => {
  const fixture = runtimeFixture("busy-session");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    const sessionId = createIdleSession(runtime, agent.principalId, fixture.repo);
    const busy = runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "busy-session-work" },
      agentId: agent.principalId,
      sessionId,
      prompt: "Remain busy until the test completes this execution.",
      createdAt: "2026-08-03T00:00:02.000Z"
    });
    const topicId = localRuntimeSnapshot(fixture.repo, fixture.options).foundation.topicId;
    const binding = bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      callbackSessionId: sessionId,
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT));
    const sent = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "local-chat", channelId: topicId },
      idempotencyKey: "busy-callback",
      body: "Wait for the exact Session.",
      quietWindowMilliseconds: 0
    }, fixture.optionsAt("2026-08-03T00:01:00.000Z"));
    const channelRuntime = new InteractiveChannelRuntime(fixture.repo, fixture.options);
    try {
      assert.deepEqual(
        (await channelRuntime.runCycle("2026-08-03T00:01:01.000Z"))
          .admittedCallbackEventIds,
        []
      );
      assert.equal(inspectInteractiveChannelFollow(
        fixture.repo, sent.receipt.followToken, fixture.runtime
      ).follow.callback?.status, "pending");
      const claimed = runtime.claimDueExecutions(20, "2026-08-03T00:01:01.000Z")
        .find(({ executionId }) => executionId === busy.execution.executionId)!;
      runtime.completeExecution(claimed.executionId, {
        adapterId: "fixture",
        workspace: fixture.repo,
        providerSessionId: `provider-${agent.principalId}`,
        sessionId,
        output: "done"
      }, "2026-08-03T00:01:02.000Z");
      assert.equal((await channelRuntime.runCycle(
        "2026-08-03T00:01:03.000Z"
      )).admittedCallbackEventIds.length, 1);
    } finally {
      channelRuntime.close();
      runtime.close();
    }
  } finally {
    fixture.close();
  }
});

test("Local first_reply ignores unrelated concurrent conversation roots", async () => {
  const fixture = runtimeFixture("first-reply-correlation");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const snapshot = localRuntimeSnapshot(fixture.repo, fixture.options);
    const topicId = snapshot.foundation.topicId;
    const binding = bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT));
    const sent = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "local-chat", channelId: topicId },
      idempotencyKey: "correlated-first-reply",
      body: "Wait for a reply in this conversation.",
      followCondition: "first_reply"
    }, fixture.optionsAt("2026-08-03T00:01:00.000Z"));
    const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
    try {
      chat.postOwnerMessage({
        topicId,
        ownerPrincipalId: snapshot.foundation.owner.principalId,
        body: "This starts an unrelated conversation.",
        at: "2026-08-03T00:01:01.000Z"
      });
    } finally {
      chat.close();
    }
    const result = await followInteractiveChannel(
      fixture.repo, sent.receipt.followToken, 0,
      fixture.optionsAt("2026-08-03T00:01:02.000Z")
    );
    assert.equal(result.follow.status, "active");
    assert.equal(result.delta.length, 1);
    assert.equal(result.delta[0]?.correlation, "new_message");
    assert.equal(result.nextCursor, result.follow.currentCursor);
  } finally {
    fixture.close();
  }
});

test("bounded Channel delta resumes from the last returned cursor without gaps", async () => {
  const fixture = runtimeFixture("delta-cursor");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const snapshot = localRuntimeSnapshot(fixture.repo, fixture.options);
    const topicId = snapshot.foundation.topicId;
    const binding = bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT));
    const sent = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "local-chat", channelId: topicId },
      idempotencyKey: "bounded-delta",
      body: "Start bounded delta.",
      quietWindowMilliseconds: 3_600_000
    }, fixture.optionsAt("2026-08-03T00:01:00.000Z"));
    const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
    try {
      for (let index = 0; index < 5; index += 1) {
        chat.postOwnerMessage({
          topicId,
          ownerPrincipalId: snapshot.foundation.owner.principalId,
          body: `${index}:${"x".repeat(15_900)}`,
          at: new Date(Date.parse("2026-08-03T00:01:01.000Z") + index).toISOString()
        });
      }
    } finally {
      chat.close();
    }
    const first = await followInteractiveChannel(
      fixture.repo, sent.receipt.followToken, 0,
      fixture.optionsAt("2026-08-03T00:01:10.000Z")
    );
    assert.ok(first.delta.length > 0 && first.delta.length < 5);
    assert.equal(first.nextCursor, first.delta.at(-1)?.cursor);
    assert.ok(first.nextCursor);
    const nextCursor = first.nextCursor;
    const second = await followInteractiveChannel(
      fixture.repo, sent.receipt.followToken, 0, {
        ...fixture.optionsAt("2026-08-03T00:01:11.000Z"),
        afterCursor: nextCursor
      }
    );
    assert.equal(first.delta.length + second.delta.length, 5);
    const cursors = [...first.delta, ...second.delta].map(({ cursor }) => cursor);
    assert.equal(new Set(cursors).size, 5);
  } finally {
    fixture.close();
  }
});

test("removed Local Topic participant cannot bind or send through an existing binding", async () => {
  const fixture = runtimeFixture("removed-participant");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const topicId = localRuntimeSnapshot(fixture.repo, fixture.options).foundation.topicId;
    const binding = bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT));
    assert.equal(removeLocalTopicParticipant(
      fixture.repo, agent.principalId, 1,
      fixture.optionsAt("2026-08-03T00:00:30.000Z")
    ).outcome, "applied");
    assert.throws(() => bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt("2026-08-03T00:00:31.000Z")), /not an active Local Topic participant/);
    const sent = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "local-chat", channelId: topicId },
      idempotencyKey: "removed-sender",
      body: "This message must not be admitted."
    }, fixture.optionsAt("2026-08-03T00:01:00.000Z"));
    assert.equal(sent.receipt.status, "failed");
    assert.match(sent.receipt.failure ?? "", /not an active Local Topic participant/);
  } finally {
    fixture.close();
  }
});

test("Channel callback fails durably when its bound Agent is suspended", async () => {
  const fixture = runtimeFixture("suspended-callback");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const runtimeStore = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    const sessionId = createIdleSession(runtimeStore, agent.principalId, fixture.repo);
    const topicId = localRuntimeSnapshot(fixture.repo, fixture.options).foundation.topicId;
    const binding = bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      callbackSessionId: sessionId,
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT));
    const sent = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "local-chat", channelId: topicId },
      idempotencyKey: "suspended-callback",
      body: "Do not callback a suspended Agent.",
      quietWindowMilliseconds: 0
    }, fixture.optionsAt("2026-08-03T00:01:00.000Z"));
    suspendLocalAgent(fixture.repo, agent.principalId,
      fixture.optionsAt("2026-08-03T00:01:01.000Z"));
    const runtime = new InteractiveChannelRuntime(fixture.repo, fixture.options);
    try {
      assert.deepEqual((await runtime.runCycle(
        "2026-08-03T00:01:02.000Z"
      )).admittedCallbackEventIds, []);
    } finally {
      runtime.close();
      runtimeStore.close();
    }
    const follow = inspectInteractiveChannelFollow(
      fixture.repo, sent.receipt.followToken, fixture.runtime
    ).follow;
    assert.equal(follow.callback?.status, "failed");
    assert.equal(follow.callback?.failure, "binding-agent-inactive");
  } finally {
    fixture.close();
  }
});

test("global bounded follow scan rotates fairly beyond one batch", async () => {
  const fixture = runtimeFixture("follow-fairness");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const topicId = localRuntimeSnapshot(fixture.repo, fixture.options).foundation.topicId;
    const binding = bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "local-chat", channelId: topicId }],
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT));
    let lastFollowToken = "";
    for (let index = 0; index < 101; index += 1) {
      const at = new Date(Date.parse("2026-08-03T00:01:00.000Z") + index).toISOString();
      const sent = await sendInteractiveChannelMessage(fixture.repo, {
        bindingId: binding.bindingId,
        channelRef: { kind: "local-chat", channelId: topicId },
        idempotencyKey: `fair-follow-${index}`,
        body: `Fair follow ${index}`,
        quietWindowMilliseconds: index === 100 ? 0 : 3_600_000
      }, fixture.optionsAt(at));
      lastFollowToken = sent.receipt.followToken;
    }
    const runtime = new InteractiveChannelRuntime(fixture.repo, fixture.options);
    try {
      await runtime.runCycle("2026-08-03T00:02:00.000Z");
      assert.equal(inspectInteractiveChannelFollow(
        fixture.repo, lastFollowToken, fixture.runtime
      ).follow.status, "active");
      await runtime.runCycle("2026-08-03T00:02:01.000Z");
    } finally {
      runtime.close();
    }
    assert.equal(inspectInteractiveChannelFollow(
      fixture.repo, lastFollowToken, fixture.runtime
    ).follow.status, "quiet");
  } finally {
    fixture.close();
  }
});

test("Channel CLI binds, sends, inspects and revokes exact Local authority", async () => {
  const fixture = runtimeFixture("cli");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const topicId = localRuntimeSnapshot(fixture.repo, fixture.options).foundation.topicId;
    const binding = await cli(fixture, [
      "channel", "bind", "alice", "--allow", `local-chat:${topicId}`,
      "--expires", "2099-08-04T00:00:00.000Z"
    ]);
    const bindingId = binding.bindingId as string;
    const sent = await cli(fixture, [
      "channel", "send", bindingId, `local-chat:${topicId}`,
      "cli-send", "CLI durable message"
    ]);
    const receipt = sent.receipt as { followToken: string; status: string };
    assert.equal(receipt.status, "accepted");
    const follow = await cli(fixture, ["channel", "follow", receipt.followToken]);
    assert.equal((follow.receipt as { status: string }).status, "accepted");
    const waited = await cli(fixture, [
      "channel", "follow", receipt.followToken, "--wait", "0"
    ]);
    assert.ok(Array.isArray(waited.delta));
    assert.equal(typeof waited.nextCursor, "string");
    const revoked = await cli(fixture, [
      "channel", "revoke", bindingId, "--revision", "1"
    ]);
    assert.equal((revoked.binding as { status: string }).status, "revoked");
  } finally {
    fixture.close();
  }
});

test("Server Channel send uses exact enrollment and stable transaction without reply attribution", async () => {
  const fixture = runtimeFixture("server");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const snapshot = localRuntimeSnapshot(fixture.repo, fixture.options);
    const paths = runtimePaths(fixture.repo, fixture.runtime);
    new DeviceCredentialStore(paths.deviceCredential).save({
      serverUrl: "http://127.0.0.1:7777",
      deviceId: snapshot.foundation.deviceId,
      credentialId: "device-credential",
      credential: "device-secret-device-secret-device-secret"
    });
    new AgentCredentialStore(paths.agentCredentials).save({
      state: "active",
      serverUrl: "http://127.0.0.1:7777",
      deviceId: snapshot.foundation.deviceId,
      name: "alice",
      verifier: "verifier",
      agentId: "agent-server-alice",
      placementId: "placement-alice",
      enrollmentId: "enrollment-alice",
      credentialId: "agent-credential",
      credential: "agent-secret-agent-secret-agent-secret"
    });
    const topicId = "topic-server";
    new TopicInboxStore(paths.topicInbox).commit({
      view: {
        subscription: {
          topicId,
          runtimeId: snapshot.foundation.deviceId,
          status: "active",
          cursor: 0,
          createdAt: AT,
          updatedAt: AT
        },
        agentIds: ["agent-server-alice"]
      },
      topic: {
        id: topicId,
        name: "Server Topic",
        visibility: "public",
        ownerHumanId: "human-owner",
        profile: {
          topicId,
          purpose: "Test Server Channel",
          participationRules: [],
          expressionRules: [],
          revision: 1,
          updatedAt: AT
        },
        createdAt: AT
      },
      participants: [{
        localAgentId: agent.principalId,
        serverAgentId: "agent-server-alice",
        profile: {
          agentId: "agent-server-alice",
          displayName: "Alice",
          role: "Agent",
          disclosure: "Automated",
          expressionRules: [],
          revision: 1,
          updatedAt: AT
        }
      }],
      page: {
        topicId,
        runtimeId: snapshot.foundation.deviceId,
        events: [],
        nextCursor: 0,
        head: 0
      },
      syncedAt: AT
    });
    const binding = bindInteractiveChannel(fixture.repo, {
      agentId: agent.principalId,
      allowedChannelRefs: [{ kind: "server-topic", channelId: topicId }],
      expiresAt: "2026-08-04T00:00:00.000Z"
    }, fixture.optionsAt(AT));
    let calls = 0;
    let transactionId = "";
    const fakeFetch: typeof fetch = async (_input, init) => {
      calls += 1;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer agent-secret-agent-secret-agent-secret");
      const body = JSON.parse(String(init?.body)) as { transactionId: string; body: string };
      transactionId = body.transactionId;
      if (calls === 1) throw new TypeError("response lost after Server acceptance");
      return Response.json({
        eventId: "event-channel-server",
        topicId,
        sequence: 7,
        publisher: {
          kind: "agent",
          agentId: "agent-server-alice",
          agentName: "alice",
          ownerHumanId: "human-owner",
          ownerDisplayName: "Owner",
          deviceId: snapshot.foundation.deviceId
        },
        transactionId: body.transactionId,
        body: body.body,
        agentProfileRevision: 1,
        topicProfileRevision: 1,
        createdAt: "2026-08-03T00:01:00.000Z"
      }, { status: 201 });
    };
    const sent = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "server-topic", channelId: topicId },
      idempotencyKey: "server-send",
      body: "Server durable message.",
      followCondition: "quiet",
      quietWindowMilliseconds: 0
    }, { ...fixture.optionsAt("2026-08-03T00:01:00.000Z"), fetch: fakeFetch });
    const replay = await sendInteractiveChannelMessage(fixture.repo, {
      bindingId: binding.bindingId,
      channelRef: { kind: "server-topic", channelId: topicId },
      idempotencyKey: "server-send",
      body: "Server durable message.",
      followCondition: "quiet",
      quietWindowMilliseconds: 0
    }, { ...fixture.optionsAt("2026-08-03T00:01:01.000Z"), fetch: fakeFetch });
    assert.equal(calls, 2);
    assert.equal(sent.receipt.status, "pending");
    assert.equal(transactionId, replay.receipt.transactionId);
    assert.equal(replay.receipt.remoteMessageId, "event-channel-server");
    assert.equal(replay.receipt.observedCursor, "7");
    assert.equal(replay.receipt.sendId, sent.receipt.sendId);
    const channelRuntime = new InteractiveChannelRuntime(fixture.repo, fixture.options);
    try {
      await channelRuntime.runCycle("2026-08-03T00:01:02.000Z");
    } finally {
      channelRuntime.close();
    }
    assert.equal(inspectInteractiveChannelFollow(
      fixture.repo, sent.receipt.followToken, fixture.runtime
    ).follow.status, "quiet");
  } finally {
    fixture.close();
  }
});

const AT = "2026-08-03T00:00:00.000Z";

function createIdleSession(runtime: RuntimeStore, agentId: string, workspace: string): string {
  const request = runtime.appendEvent({
    type: "agent.request",
    source: { kind: "cli", externalId: `fixture-session:${agentId}` },
    agentId,
    prompt: "Create an idle durable Session.",
    createdAt: AT
  });
  const claimed = runtime.claimDueExecutions(1, AT)[0]!;
  assert.equal(claimed.eventId, request.event.eventId);
  runtime.completeExecution(claimed.executionId, {
    adapterId: "fixture",
    workspace,
    providerSessionId: `provider-${agentId}`,
    output: "ready"
  }, "2026-08-03T00:00:01.000Z");
  return runtime.sessions().find((session) => session.agentId === agentId)!.sessionId;
}

function runtimeFixture(name: string) {
  const repo = mkdtempSync(join(tmpdir(), `rollerskate-channel-${name}-repo-`));
  const runtime = mkdtempSync(join(tmpdir(), `rollerskate-channel-${name}-runtime-`));
  return {
    repo,
    runtime,
    options: { runtimeDirectory: runtime },
    optionsAt: (at: string) => ({ runtimeDirectory: runtime, now: () => new Date(at) }),
    close: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  };
}

async function cli(
  fixture: ReturnType<typeof runtimeFixture>,
  arguments_: readonly string[]
): Promise<Record<string, unknown>> {
  let output = "";
  assert.equal(await runLocalApp(fixture.repo, [
    "--runtime", fixture.runtime, ...arguments_
  ], {}, { write(text) { output += text; } }), 0);
  return JSON.parse(output) as Record<string, unknown>;
}
