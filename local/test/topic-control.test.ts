import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { AgentCredentialStore } from "../src/infrastructure/files/agent-credential-store.js";
import { DeviceCredentialStore } from "../src/infrastructure/files/device-credential-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import {
  joinServerTopic,
  publishHumanServerTopicMessage,
  updateAgentPublicProfile
} from "../src/application/topic/control.js";

const AT = "2026-07-27T12:00:00.000Z";
const TOPIC_ID = "topic-a";
const AGENT_ID = "agent-a";

test("profile and Topic CLI select Human and Agent credentials without execution authority", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-topic-control-"));
  const runtime = join(repo, "runtime");
  const paths = runtimePaths(repo, runtime);
  try {
    mkdirSync(runtime, { mode: 0o700 });
    const foundation = bootstrapLocalFoundation(paths, AT);
    const agents = new LocalFoundationStore(paths.database);
    agents.addAgent("alice", "codex", AT);
    agents.close();
    new DeviceCredentialStore(paths.deviceCredential).save({
      serverUrl: "http://127.0.0.1:7777",
      deviceId: foundation.deviceId,
      credentialId: "device-credential",
      credential: "device-secret"
    });
    const agentCredentials = new AgentCredentialStore(paths.agentCredentials);
    agentCredentials.save(activeCredential(foundation.deviceId));

    let profileRevision = 1;
    const authorizations: Array<{ path: string; value: string | null }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(init?.headers).get("authorization");
      authorizations.push({ path: url.pathname, value: authorization });
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.pathname === `/api/agents/${AGENT_ID}/profile`) {
        assert.equal(authorization, "Bearer device-secret");
        if (init?.method === "PATCH") {
          if (body.expectedRevision !== profileRevision) {
            return Response.json({ error: "revision_conflict", message: "revision conflict" }, {
              status: 409
            });
          }
          profileRevision += 1;
        }
        return Response.json(agentProfile(profileRevision));
      }
      if (url.pathname === "/api/topics" && init?.method === "POST") {
        assert.equal(authorization, "Bearer device-secret");
        return Response.json(topicSummary(), { status: 201 });
      }
      if (url.pathname === "/api/topics" && init?.method === "GET") {
        assert.equal(authorization, "Bearer device-secret");
        return Response.json([topicSummary()]);
      }
      if (url.pathname === `/api/topics/${TOPIC_ID}/profile` && init?.method === "PATCH") {
        assert.equal(authorization, "Bearer device-secret");
        return Response.json({
          ...topicSummary(),
          profile: { ...topicSummary().profile, revision: 2 }
        });
      }
      if (url.pathname === `/api/topics/${TOPIC_ID}/memberships` && init?.method === "POST") {
        assert.equal(authorization, "Bearer device-secret");
        assert.equal(body.agentId, AGENT_ID);
        return Response.json(joinReceipt(foundation.deviceId));
      }
      if (url.pathname === `/api/topics/${TOPIC_ID}/events` && init?.method === "POST") {
        assert.equal(authorization, "Bearer agent-secret");
        return Response.json({
          eventId: "event-a",
          topicId: TOPIC_ID,
          sequence: 1,
          publisher: {
            kind: "agent",
            agentId: AGENT_ID,
            agentName: "alice",
            ownerHumanId: "human-a",
            ownerDisplayName: "Alice",
            deviceId: foundation.deviceId
          },
          transactionId: body.transactionId,
          body: body.body,
          agentProfileRevision: profileRevision,
          topicProfileRevision: 2,
          createdAt: AT
        }, { status: 201 });
      }
      if (url.pathname === `/api/topics/${TOPIC_ID}/human-events` && init?.method === "POST") {
        assert.equal(authorization, "Bearer device-secret");
        return Response.json({
          eventId: "human-event-a",
          topicId: TOPIC_ID,
          sequence: 2,
          publisher: {
            kind: "human",
            humanId: "human-a",
            displayName: "Alice",
            deviceId: foundation.deviceId
          },
          transactionId: body.transactionId,
          body: body.body,
          topicProfileRevision: 2,
          createdAt: AT
        }, { status: 201 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    };

    const createFile = join(repo, "topic.json");
    const agentProfileFile = join(repo, "agent-profile.json");
    const topicProfileFile = join(repo, "topic-profile.json");
    writeFileSync(createFile, JSON.stringify({
      name: "Research",
      visibility: "public",
      profile: profileInput()
    }));
    writeFileSync(agentProfileFile, JSON.stringify({
      displayName: "Alice Researcher",
      role: "Independent Agent",
      disclosure: "Automated Agent",
      expressionRules: ["Separate evidence from inference."],
      expectedRevision: 1
    }));
    writeFileSync(topicProfileFile, JSON.stringify({
      ...profileInput(),
      expectedRevision: 1
    }));
    let output = "";
    const run = (argv: readonly string[]) => runLocalApp(
      repo,
      ["--runtime", runtime, ...argv],
      {},
      { write(text) { output += text; } },
      { fetch: fakeFetch, cwd: repo }
    );
    assert.equal(await run(["agent", "profile", "alice"]), 0);
    assert.equal(await run(["agent", "profile", "alice", "update", agentProfileFile]), 0);
    assert.equal(await run(["topic", "create", createFile]), 0);
    assert.equal(await run(["topic", "server-list"]), 0);
    assert.equal(await run(["topic", "profile", "update", TOPIC_ID, topicProfileFile]), 0);
    assert.equal(await run(["topic", "join", TOPIC_ID, "alice"]), 0);
    assert.equal(await run([
      "topic", "publish", TOPIC_ID, "alice", "transaction-a", "Evidence", "first."
    ]), 0);
    assert.match(output, /Alice Researcher/);
    assert.match(output, /Evidence first\./);
    assert.equal((await publishHumanServerTopicMessage(
      repo,
      TOPIC_ID,
      "human-transaction-a",
      "Human question",
      { runtimeDirectory: runtime, fetch: fakeFetch }
    )).publisher.kind, "human");

    await assert.rejects(() => updateAgentPublicProfile(repo, "alice", {
      displayName: "Alice Researcher",
      role: "Independent Agent",
      disclosure: "Automated Agent",
      expressionRules: [],
      expectedRevision: 1
    }, { runtimeDirectory: runtime, fetch: fakeFetch }), /revision conflict/);

    agentCredentials.save({ ...activeCredential("different-device") });
    await assert.rejects(
      () => joinServerTopic(repo, TOPIC_ID, "alice", {
        runtimeDirectory: runtime,
        fetch: fakeFetch
      }),
      /different Server, Device or Local Agent/
    );
    assert.ok(authorizations.some((entry) =>
      entry.path.endsWith("/events") && entry.value === "Bearer agent-secret"));
    assert.ok(authorizations.some((entry) =>
      entry.path.endsWith("/human-events") && entry.value === "Bearer device-secret"));
    assert.ok(authorizations.filter((entry) => entry.value === "Bearer device-secret").length >= 5);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function activeCredential(deviceId: string) {
  return {
    state: "active" as const,
    serverUrl: "http://127.0.0.1:7777",
    deviceId,
    name: "alice",
    verifier: "verifier",
    agentId: AGENT_ID,
    placementId: "placement-a",
    enrollmentId: "enrollment-a",
    credentialId: "agent-credential",
    credential: "agent-secret"
  };
}

function agentProfile(revision: number) {
  return {
    agentId: AGENT_ID,
    displayName: "Alice Researcher",
    role: "Independent Agent",
    disclosure: "Automated Agent",
    expressionRules: ["Separate evidence from inference."],
    revision,
    updatedAt: AT
  };
}

function profileInput() {
  return {
    purpose: "Bounded public research",
    participationRules: ["Disclose automation."],
    expressionRules: ["Label uncertainty."]
  };
}

function topicSummary() {
  return {
    id: TOPIC_ID,
    name: "Research",
    visibility: "public" as const,
    ownerHumanId: "human-a",
    profile: {
      topicId: TOPIC_ID,
      ...profileInput(),
      revision: 1,
      updatedAt: AT
    },
    createdAt: AT
  };
}

function joinReceipt(runtimeId: string) {
  return {
    membership: {
      topicId: TOPIC_ID,
      agentId: AGENT_ID,
      status: "active",
      joinedByHumanId: "human-a",
      createdAt: AT,
      updatedAt: AT
    },
    subscription: {
      topicId: TOPIC_ID,
      runtimeId,
      status: "active",
      cursor: 0,
      createdAt: AT,
      updatedAt: AT
    }
  };
}
