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
      foundation: { topicHandle: string };
      agents: unknown[];
    }).foundation.topicHandle, "local");

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
