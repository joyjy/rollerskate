import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentSummary } from "../src/protocol.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import {
  configureAgents,
  createAgent,
  listAgents,
  statusAgent
} from "../src/application/agent/server-control.js";
import { DeviceCredentialStore } from "../src/infrastructure/files/device-credential-store.js";

const SERVER_URL = "http://127.0.0.1:7777";
const DEVICE_ID = "device-id";
const DEVICE_CREDENTIAL = "device-credential.device-secret";

test.skip("v0.4 Server Agent binding provisions isolated Agents and recovers them", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-agents-"));
  const runtime = join(repo, "runtime");
  const workspaceRoot = join(repo, "workspaces");
  const paths = runtimePaths(repo, runtime);
  const agents = new Map<string, {
    summary: AgentSummary;
    enrollmentId: string;
    challenge: string;
    credential?: string;
  }>();
  const authorizations: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    authorizations.push(authorization);
    if (url.pathname === "/api/agents" && init?.method === "POST") {
      assert.equal(authorization, `Bearer ${DEVICE_CREDENTIAL}`);
      const body = JSON.parse(String(init.body)) as {
        name: string;
        verifierChallenge: string;
      };
      const current = agents.get(body.name) ?? createFixture(body.name, body.verifierChallenge);
      agents.set(body.name, current);
      return Response.json({
        agent: current.summary,
        enrollment: {
          id: current.enrollmentId,
          agentId: current.summary.id,
          deviceId: DEVICE_ID,
          placementId: current.summary.placement.id,
          status: current.credential === undefined ? "issued" : "redeemed",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      }, { status: 201 });
    }
    if (url.pathname === "/api/agents" && init?.method === "GET") {
      assert.equal(authorization, `Bearer ${DEVICE_CREDENTIAL}`);
      return Response.json([...agents.values()].map((agent) => agent.summary));
    }
    const redeem = /^\/api\/agent-enrollments\/([^/]+)\/redeem$/.exec(url.pathname)?.[1];
    if (redeem !== undefined) {
      assert.equal(authorization, `Bearer ${DEVICE_CREDENTIAL}`);
      const fixture = [...agents.values()].find((agent) => agent.enrollmentId === redeem);
      assert.ok(fixture !== undefined);
      const body = JSON.parse(String(init?.body)) as { verifier: string };
      assert.equal(challenge(body.verifier), fixture.challenge);
      fixture.credential ??= `${fixture.enrollmentId}.${body.verifier}`;
      fixture.summary = activeSummary(fixture.summary);
      return Response.json({
        credentialId: fixture.enrollmentId,
        credential: fixture.credential,
        agent: fixture.summary
      });
    }
    const principal = /^\/api\/agent-principals\/([^/]+)$/.exec(url.pathname)?.[1];
    if (principal !== undefined) {
      const fixture = [...agents.values()].find((agent) => agent.summary.id === principal);
      if (fixture === undefined || authorization !== `Bearer ${fixture.credential}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json(fixture.summary);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  try {
    const configured = configureAgents(repo, workspaceRoot, runtime);
    const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
    assert.equal(configured.workspaceRoot, canonicalWorkspaceRoot);
    assert.equal(configureAgents(repo, workspaceRoot, runtime).workspaceRoot, canonicalWorkspaceRoot);
    assert.throws(
      () => configureAgents(repo, join(repo, "other-workspaces"), runtime),
      /already configured differently/
    );
    new DeviceCredentialStore(paths.deviceCredential).save({
      serverUrl: SERVER_URL,
      deviceId: DEVICE_ID,
      credentialId: "device-credential",
      credential: DEVICE_CREDENTIAL
    });

    const alice = await createAgent(repo, "alice", {
      runtimeDirectory: runtime,
      fetch: fakeFetch,
      now: () => new Date("2026-07-19T10:00:00.000Z")
    });
    const bob = await createAgent(repo, "bob", {
      runtimeDirectory: runtime,
      fetch: fakeFetch,
      now: () => new Date("2026-07-19T10:01:00.000Z"),
      client: "claude-code"
    });
    assert.notEqual(alice.summary.id, bob.summary.id);
    assert.notEqual(alice.metadata.credentialId, bob.metadata.credentialId);
    assert.equal(alice.metadata.workspacePath, join(canonicalWorkspaceRoot, "alice"));
    assert.equal(bob.metadata.workspacePath, join(canonicalWorkspaceRoot, "bob"));
    assert.equal(alice.metadata.client, "codex");
    assert.equal(bob.metadata.client, "claude-code");
    assert.equal(lstatSync(alice.metadata.workspacePath).isDirectory(), true);
    assert.equal(lstatSync(bob.metadata.workspacePath).isDirectory(), true);

    const restartedAlice = await statusAgent(
      repo,
      "alice",
      { runtimeDirectory: runtime, fetch: fakeFetch }
    );
    assert.equal(restartedAlice.summary.id, alice.summary.id);
    assert.equal((await statusAgent(
      repo,
      "bob",
      { runtimeDirectory: runtime, fetch: fakeFetch }
    )).summary.id, bob.summary.id);
    assert.deepEqual(
      (await listAgents(repo, { runtimeDirectory: runtime, fetch: fakeFetch }))
        .map((agent) => agent.summary.name),
      ["alice", "bob"]
    );
    assert.equal((await createAgent(
      repo,
      "alice",
      { runtimeDirectory: runtime, fetch: fakeFetch }
    )).summary.id, alice.summary.id);
    await assert.rejects(() => createAgent(repo, "bob", {
      runtimeDirectory: runtime,
      fetch: fakeFetch,
      client: "codex"
    }), /already uses client claude-code/);

    const aliceSecret = readFileSync(join(paths.agentCredentials, "alice.json"), "utf8");
    const bobSecret = readFileSync(join(paths.agentCredentials, "bob.json"), "utf8");
    assert.equal(lstatSync(join(paths.agentCredentials, "alice.json")).mode & 0o777, 0o600);
    assert.equal(lstatSync(paths.agentCredentials).mode & 0o777, 0o700);
    assert.doesNotMatch(readFileSync(paths.database).toString("utf8"), /device-secret/);
    const aliceVerifier = (JSON.parse(aliceSecret) as { verifier: string }).verifier;
    const bobVerifier = (JSON.parse(bobSecret) as { verifier: string }).verifier;
    assert.notEqual(aliceVerifier, bobVerifier);
    const databaseBytes = readFileSync(paths.database).toString("utf8");
    assert.doesNotMatch(databaseBytes, new RegExp(aliceVerifier));
    assert.doesNotMatch(databaseBytes, new RegExp(bobVerifier));
    assert.ok(authorizations.includes(`Bearer ${DEVICE_CREDENTIAL}`));
    assert.ok(authorizations.some((value) => value.startsWith("Bearer enrollment-alice.")));
    assert.ok(authorizations.some((value) => value.startsWith("Bearer enrollment-bob.")));
    await assert.rejects(() => createAgent(
      repo,
      "../escape",
      { runtimeDirectory: runtime, fetch: fakeFetch }
    ));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function createFixture(name: string, verifierChallenge: string): {
  summary: AgentSummary;
  enrollmentId: string;
  challenge: string;
  credential?: string;
} {
  return {
    enrollmentId: `enrollment-${name}`,
    challenge: verifierChallenge,
    summary: {
      id: `agent-${name}`,
      name,
      status: "provisioning",
      createdAt: "2026-07-19T10:00:00.000Z",
      owner: { id: "human-id", displayName: "Example Human", isAdmin: false },
      operator: { id: "human-id", displayName: "Example Human", isAdmin: false },
      placement: {
        id: `placement-${name}`,
        deviceId: DEVICE_ID,
        state: "pending",
        generation: 1,
        createdAt: "2026-07-19T10:00:00.000Z"
      },
      credentialStatus: "pending"
    }
  };
}

function activeSummary(summary: AgentSummary): AgentSummary {
  return {
    ...summary,
    status: "active",
    placement: {
      ...summary.placement,
      state: "active",
      activatedAt: "2026-07-19T10:00:01.000Z"
    },
    credentialStatus: "active"
  };
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}
