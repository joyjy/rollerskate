import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { doctorLocalRuntime } from "../src/application/runtime/doctor.js";
import { enqueueAgentRequest } from "../src/application/agent/server-control.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { setupLocalRuntime } from "../src/infrastructure/runtime/config.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

test("doctor checks local state and exact Matrix identity without exposing the token", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-app-doctor-"));
  const runtimeDirectory = join(repo, "runtime");
  try {
    const codex = join(repo, "codex");
    writeFileSync(codex, "fixture");
    chmodSync(codex, 0o700);
    const setup = setupLocalRuntime(repo, {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      ownerUserId: "@owner:example",
      agentUserId: "@rollerskate:example",
      matrixAccessToken: "secret-token",
      projectRoot: repo,
      codexExecutable: codex
    }, undefined, runtimeDirectory);
    let requests = 0;
    const result = await doctorLocalRuntime(repo, {
      runtimeDirectory,
      fetch: async (input, init) => {
        requests += 1;
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          "Bearer secret-token"
        );
        assert.doesNotMatch(String(input), /secret-token/);
        return String(input).endsWith("/account/whoami")
          ? Response.json({
              user_id: "@rollerskate:example",
              device_id: "DEVICE-1"
            })
          : Response.json({ joined_rooms: ["!room:example"] });
      }
    });
    assert.equal(requests, 2);
    assert.equal(result.status, "ready");
    assert.equal(result.projectRoot, setup.config.projectRoot);
    assert.equal(result.schemaVersion, 75);
    assert.deepEqual(result.matrix, {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      userId: "@rollerskate:example",
      deviceId: "DEVICE-1"
    });
    assert.doesNotMatch(JSON.stringify(result), /secret-token/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("local doctor validates Local-first state without legacy config", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-local-doctor-"));
  const runtimeDirectory = join(repo, "runtime");
  try {
    mkdirSync(runtimeDirectory);
    const paths = runtimePaths(repo, runtimeDirectory);
    const foundation = bootstrapLocalFoundation(paths);
    const result = await doctorLocalRuntime(repo, {
      includeMatrix: false,
      runtimeDirectory
    });

    assert.equal(result.status, "ready");
    assert.equal(result.projectRoot, foundation.workspacePath);
    assert.equal(result.database, paths.database);
    assert.equal(result.schemaVersion, 75);
    assert.equal(result.matrix, undefined);
    assert.equal(result.codexExecutable, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agent request admits current Local Agents and rejects a foreign explicit Session", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-agent-request-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-agent-request-runtime-"));
  try {
    const database = runtimePaths(repo, runtimeDirectory).database;
    const foundation = new LocalFoundationStore(database);
    const alice = foundation.addAgent("alice", "codex");
    const bob = foundation.addAgent("bob", "codex");
    foundation.close();

    const runtime = new RuntimeStore(database);
    runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: bob.principalId,
      prompt: "seed Bob Session"
    });
    const execution = runtime.claimDueExecutions()[0]!;
    const result = runtime.completeExecution(execution.executionId, {
      adapterId: "codex-runtime-app-server-v1",
      workspace: repo,
      providerSessionId: "bob-provider-session",
      output: "seeded"
    });
    const bobSessionId = result?.sessionId;
    assert.ok(bobSessionId);
    runtime.close();

    const receipt = enqueueAgentRequest(repo, "alice", "current Agent request", {
      runtimeDirectory
    });
    assert.equal(receipt.event.agentId, alice.principalId);
    assert.throws(
      () => enqueueAgentRequest(repo, "alice", "wrong Session", {
        runtimeDirectory,
        sessionId: bobSessionId
      }),
      /Session does not belong to Agent alice/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
