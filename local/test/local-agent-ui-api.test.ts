import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startUiServer } from "../src/entrypoints/console/launcher.js";

test("loopback Console API manages local Agents without Server login", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-local-agent-api-"));
  const controller = new AbortController();
  const server = await startUiServer({
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    runtimeDirectory: runtime,
    port: 0,
    signal: controller.signal
  });
  const origin = new URL(server.url).origin;
  try {
    const local = await jsonRequest(`${origin}/api/local`);
    assert.equal(local.response.status, 200);
    assert.equal((local.body as {
      foundation: { topicHandle: string; topicId: string };
      agents: unknown[];
    }).foundation.topicHandle, "local");
    const localTopicId = (local.body as {
      foundation: { topicId: string };
    }).foundation.topicId;

    for (const action of ["confirm-recovery", "retry-orchestrator"]) {
      const recovery = await jsonRequest(`${origin}/api/runs/run-missing/${action}`, {
        method: "POST", body: JSON.stringify({})
      });
      assert.equal(recovery.response.status, 403);
    }
    const invalidRecovery = await jsonRequest(`${origin}/api/runs/run-missing/confirm-recovery`, {
      method: "POST", headers: consoleHeaders(), body: JSON.stringify({})
    });
    assert.equal(invalidRecovery.response.status, 400);
    assert.match(String((invalidRecovery.body as {error: string}).error), /revision/);
    const invalidRetry = await jsonRequest(`${origin}/api/runs/run-missing/retry-orchestrator`, {
      method: "POST", headers: consoleHeaders(), body: JSON.stringify({requestId: "retry"})
    });
    assert.equal(invalidRetry.response.status, 400);
    assert.match(String((invalidRetry.body as {error: string}).error), /expectedVersion/);

    const rejected = await jsonRequest(`${origin}/api/agents`, {
      method: "POST",
      body: JSON.stringify({ handle: "alice" })
    });
    assert.equal(rejected.response.status, 403);

    const missingClient = await jsonRequest(`${origin}/api/agents`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ handle: "alice" })
    });
    assert.equal(missingClient.response.status, 400);

    const created = await jsonRequest(`${origin}/api/agents`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({
        handle: "alice",
        client: "claude-code",
        launchArgs: ["--model", "claude-sonnet-4-6"]
      })
    });
    assert.equal(created.response.status, 201);
    const alice = created.body as {
      principalId: string;
      handle: string;
      status: string;
      client: string;
    };
    assert.equal(alice.handle, "alice");
    assert.equal(alice.status, "active");
    assert.equal(alice.client, "claude-code");

    const governance = await jsonRequest(`${origin}/api/chat/governance`);
    assert.equal(governance.response.status, 200);
    const governanceView = governance.body as {
      governance: { status: string; revision: number };
      activeParticipantAgentIds: string[];
      actionAvailability: { pause: boolean; expectedRevision: number };
    };
    assert.equal(governanceView.governance.status, "active");
    assert.equal(governanceView.governance.revision, 1);
    assert.deepEqual(governanceView.activeParticipantAgentIds, [alice.principalId]);
    assert.equal(governanceView.actionAvailability.pause, true);
    assert.equal(governanceView.actionAvailability.expectedRevision, 1);
    const rejectedPause = await jsonRequest(`${origin}/api/chat/governance/pause`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1 })
    });
    assert.equal(rejectedPause.response.status, 403);
    const pausedTopic = await jsonRequest(`${origin}/api/chat/governance/pause`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ expectedRevision: 1 })
    });
    assert.equal(pausedTopic.response.status, 200);
    assert.equal((pausedTopic.body as { outcome: string }).outcome, "applied");
    const staleResume = await jsonRequest(`${origin}/api/chat/governance/resume`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ expectedRevision: 1 })
    });
    assert.equal(staleResume.response.status, 409);
    assert.equal((staleResume.body as {
      governance: { status: string; revision: number };
    }).governance.revision, 2);
    const resumedTopic = await jsonRequest(`${origin}/api/chat/governance/resume`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ expectedRevision: 2 })
    });
    assert.equal(resumedTopic.response.status, 200);
    assert.equal((resumedTopic.body as { outcome: string }).outcome, "applied");
    assert.equal("conversation" in ((await jsonRequest(`${origin}/api/chat`)).body as object), false);
    const retiredWake = await jsonRequest(`${origin}/api/chat/governance/resume-and-wake`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ expectedRevision: 3, idempotencyKey: "api-resume-wake" })
    });
    assert.equal(retiredWake.response.status, 405);

    const rejectedActivity = await jsonRequest(
      `${origin}/api/network/activity/alice/grant`,
      { method: "POST" }
    );
    assert.equal(rejectedActivity.response.status, 403);
    const grantedActivity = await jsonRequest(
      `${origin}/api/network/activity/alice/grant`,
      { method: "POST", headers: consoleHeaders() }
    );
    assert.equal(grantedActivity.response.status, 200);
    assert.equal((grantedActivity.body as { scope: string }).scope, "owner-wide-read");

    const configured = await jsonRequest(
      `${origin}/api/agents/${alice.principalId}/configure`,
      {
        method: "POST",
        headers: consoleHeaders(),
        body: JSON.stringify({ launchArgs: ["--model", "claude-opus-4-6"] })
      }
    );
    assert.equal(configured.response.status, 200);
    assert.deepEqual(
      (configured.body as { executionConfig: { launchArgs: string[] } })
        .executionConfig.launchArgs,
      ["--model", "claude-opus-4-6"]
    );

    const renamed = await jsonRequest(`${origin}/api/agents/${alice.principalId}/rename`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ handle: "helper" })
    });
    assert.equal(renamed.response.status, 200);
    assert.equal((renamed.body as { handle: string }).handle, "helper");

    const suspended = await jsonRequest(`${origin}/api/agents/${alice.principalId}/suspend`, {
      method: "POST",
      headers: consoleHeaders()
    });
    assert.equal((suspended.body as { status: string }).status, "suspended");
    const suspendedPresence = await jsonRequest(`${origin}/api/chat/presence`);
    assert.equal(suspendedPresence.response.status, 200);
    const suspendedPresenceAgent = (suspendedPresence.body as {
      agents: Array<{ status: string; clientHistory?: unknown }>;
    }).agents[0];
    assert.equal(suspendedPresenceAgent?.status, "suspended");
    assert.equal(suspendedPresenceAgent?.clientHistory, undefined);
    const resumed = await jsonRequest(`${origin}/api/agents/${alice.principalId}/resume`, {
      method: "POST",
      headers: consoleHeaders()
    });
    assert.equal((resumed.body as { status: string }).status, "active");

    const listed = await jsonRequest(`${origin}/api/agents`);
    assert.deepEqual(
      (listed.body as Array<{ handle: string }>).map(({ handle }) => handle),
      ["helper"]
    );

    const initialPresence = await jsonRequest(`${origin}/api/chat/presence`);
    assert.equal(initialPresence.response.status, 200);
    assert.equal((initialPresence.body as {
      agents: Array<{ handle: string; topic?: unknown }>;
    }).agents[0]?.handle, "helper");

    const rejectedPresence = await jsonRequest(
      `${origin}/api/chat/agents/${alice.principalId}/presence`,
      {
        method: "POST",
        body: JSON.stringify({ mode: "available" })
      }
    );
    assert.equal(rejectedPresence.response.status, 403);

    const until = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const snoozed = await jsonRequest(
      `${origin}/api/chat/agents/${alice.principalId}/presence`,
      {
        method: "POST",
        headers: consoleHeaders(),
        body: JSON.stringify({ mode: "snoozed", until })
      }
    );
    assert.equal(snoozed.response.status, 200);
    assert.equal((snoozed.body as { mode: string }).mode, "snoozed");

    const persistedPresence = await jsonRequest(`${origin}/api/chat/presence`);
    assert.equal((persistedPresence.body as {
      agents: Array<{ topic?: { mode: string; until?: string } }>;
    }).agents[0]?.topic?.mode, "snoozed");
    assert.equal((persistedPresence.body as {
      agents: Array<{ topic?: { mode: string; until?: string } }>;
    }).agents[0]?.topic?.until, until);

    const listening = await jsonRequest(
      `${origin}/api/chat/agents/${alice.principalId}/presence`,
      {
        method: "POST",
        headers: consoleHeaders(),
        body: JSON.stringify({ mode: "available" })
      }
    );
    assert.equal(listening.response.status, 200);
    assert.equal((listening.body as { mode: string }).mode, "available");

    const rejectedMessage = await jsonRequest(`${origin}/api/chat/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "route this" })
    });
    assert.equal(rejectedMessage.response.status, 403);

    const posted = await jsonRequest(`${origin}/api/chat/messages`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ body: "route this" })
    });
    assert.equal(posted.response.status, 201);
    const sourceEventId = (posted.body as {
      message: { eventId: string };
    }).message.eventId;
    const reply = await jsonRequest(`${origin}/api/chat/messages`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ body: "ref this", replyToEventId: sourceEventId })
    });
    assert.equal(reply.response.status, 201);
    assert.equal((reply.body as {
      message: { replyToEventId?: string };
    }).message.replyToEventId, sourceEventId);

    const dispatched = await jsonRequest(
      `${origin}/api/chat/messages/${sourceEventId}/dispatch`,
      {
        method: "POST",
        headers: consoleHeaders(),
        body: JSON.stringify({ principalId: alice.principalId })
      }
    );
    assert.equal(dispatched.response.status, 200);
    assert.equal((dispatched.body as {
      status: string;
      event: { type: string; agentId: string };
    }).status, "accepted");
    assert.equal((dispatched.body as {
      event: { type: string; agentId: string };
    }).event.type, "chat.dispatch");

    const duplicate = await jsonRequest(
      `${origin}/api/chat/messages/${sourceEventId}/dispatch`,
      {
        method: "POST",
        headers: consoleHeaders(),
        body: JSON.stringify({ principalId: alice.principalId })
      }
    );
    assert.equal((duplicate.body as { status: string }).status, "duplicate");

    const codex = await jsonRequest(`${origin}/api/agents`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ handle: "codex", client: "codex" })
    });
    assert.equal(codex.response.status, 201);
    const rejectedHandoff = await jsonRequest(
      `${origin}/api/chat/messages/${sourceEventId}/run`,
      { method: "POST" }
    );
    assert.equal(rejectedHandoff.response.status, 403);
    const removedHandoff = await jsonRequest(
      `${origin}/api/chat/messages/${sourceEventId}/run`,
      { method: "POST", headers: consoleHeaders() }
    );
    assert.equal(removedHandoff.response.status, 405);

    const rotated = await jsonRequest(
      `${origin}/api/chat/agents/${alice.principalId}/new-session`,
      { method: "POST", headers: consoleHeaders() }
    );
    assert.equal((rotated.body as { generation: number }).generation, 2);

    const chat = await jsonRequest(`${origin}/api/chat`);
    const chatView = chat.body as {
      chat: { handle: string };
      events: Array<{ type: string; eventId: string }>;
      timeline: {
        items: Array<{ eventId: string; sender: { handleSnapshot: string } }>;
      };
    };
    assert.equal(chatView.chat.handle, "local");
    assert.ok(chatView.events.some(
      ({ type, eventId }) => type === "chat.message" && eventId === sourceEventId
    ));
    assert.ok(chatView.events.some(({ type }) => type === "chat.dispatch"));
    assert.ok(chatView.timeline.items.some(
      ({ eventId, sender }) =>
        eventId === sourceEventId && sender.handleSnapshot === "owner"
    ));

    const pagedChat = await jsonRequest(`${origin}/api/chat?limit=1`);
    assert.equal((pagedChat.body as {
      timeline: { items: unknown[] };
    }).timeline.items.length, 1);

    const removedParticipant = await jsonRequest(
      `${origin}/api/chat/governance/participants/${alice.principalId}/remove`,
      {
        method: "POST",
        headers: consoleHeaders(),
        body: JSON.stringify({ expectedRevision: 3 })
      }
    );
    assert.equal(removedParticipant.response.status, 200);
    assert.deepEqual((removedParticipant.body as {
      governance: { participants: Array<{ status: string }> };
    }).governance.participants.map(({ status }) => status), ["removed"]);
    const restoredParticipant = await jsonRequest(
      `${origin}/api/chat/governance/participants/${alice.principalId}/add`,
      {
        method: "POST",
        headers: consoleHeaders(),
        body: JSON.stringify({ expectedRevision: 4 })
      }
    );
    assert.equal(restoredParticipant.response.status, 200);
    assert.deepEqual((restoredParticipant.body as {
      governance: { participants: Array<{ status: string }> };
    }).governance.participants.map(({ status }) => status), ["active"]);

    const retiredFreeChat = await jsonRequest(`${origin}/api/chat/free-chat`, {
      headers: consoleHeaders()
    });
    assert.equal(retiredFreeChat.response.status, 404);
    const retiredFreeChatStart = await jsonRequest(`${origin}/api/chat/free-chat/start`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ idempotencyKey: "api-free-chat" })
    });
    assert.equal(retiredFreeChatStart.response.status, 405);

    const scheduled = await jsonRequest(`${origin}/api/chat/schedules`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({
        kind: "once",
        expression: "2099-08-03T01:00:00.000Z",
        misfirePolicy: "skip",
        candidatePolicy: "deterministic_one"
      })
    });
    assert.equal(scheduled.response.status, 201);
    assert.equal((await jsonRequest(`${origin}/api/chat/schedules`)).response.status, 200);

    const channelBinding = await jsonRequest(`${origin}/api/channels/bindings`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({
        agentId: alice.principalId,
        allowedChannelRefs: [{ kind: "local-chat", channelId: localTopicId }],
        expiresAt: "2099-08-04T00:00:00.000Z"
      })
    });
    assert.equal(channelBinding.response.status, 201);
    const bindingId = (channelBinding.body as { bindingId: string }).bindingId;
    const channelSend = await jsonRequest(`${origin}/api/channels/${bindingId}/send`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({
        channelRef: { kind: "local-chat", channelId: localTopicId },
        idempotencyKey: "api-channel-send",
        body: "API durable Channel message."
      })
    });
    assert.equal(channelSend.response.status, 201);
    const followToken = (channelSend.body as {
      receipt: { followToken: string };
    }).receipt.followToken;
    assert.equal((await jsonRequest(
      `${origin}/api/channels/follows/${followToken}`
    )).response.status, 200);
    const revokedChannel = await jsonRequest(`${origin}/api/channels/${bindingId}/revoke`, {
      method: "POST",
      headers: consoleHeaders(),
      body: JSON.stringify({ expectedRevision: 1 })
    });
    assert.equal(revokedChannel.response.status, 200);
    assert.equal((revokedChannel.body as {
      binding: { status: string };
    }).binding.status, "revoked");

    const removedRoomApi = await jsonRequest(`${origin}/api/room`);
    assert.equal(removedRoomApi.response.status, 404);
    assert.deepEqual(removedRoomApi.body, { error: "not_found" });
  } finally {
    controller.abort();
    await server.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

function consoleHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Rollerskate-Request": "console"
  };
}

async function jsonRequest(
  input: string,
  init?: RequestInit
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(input, init);
  return { response, body: await response.json() as unknown };
}
