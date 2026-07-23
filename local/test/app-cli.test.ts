import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { roomAgentEnvironment, runLocalApp } from "../src/entrypoints/cli/main.js";
import { loadLocalRuntime } from "../src/application/runtime-config.js";

 test("setup command accepts non-interactive environment without leaking its token", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-app-cli-"));
  try {
    const codex = join(repo, "codex");
    writeFileSync(codex, "fixture");
    chmodSync(codex, 0o700);
    let output = "";
    const code = await runLocalApp(repo, ["setup"], {
      PATH: "/bin:/usr/bin",
      ROLLERSKATE_MATRIX_HOMESERVER: "https://matrix.example",
      ROLLERSKATE_MATRIX_ROOM_ID: "!room:example",
      ROLLERSKATE_MATRIX_OWNER_USER: "@owner:example",
      ROLLERSKATE_MATRIX_AGENT_USER: "@rollerskate:example",
      ROLLERSKATE_MATRIX_ACCESS_TOKEN: "secret-token",
      ROLLERSKATE_PROJECT_ROOT: repo,
      ROLLERSKATE_CODEX_EXECUTABLE: codex
    }, {
      write: (text) => {
        output += text;
      }
    });
    assert.equal(code, 0);
    assert.match(output, /Rollerskate setup complete/);
    assert.doesNotMatch(output, /secret-token/);
    assert.equal(loadLocalRuntime(repo).matrixAccessToken, "secret-token");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repo-local script resolves Rollerskate independently of caller cwd", () => {
  const caller = mkdtempSync(join(tmpdir(), "rollerskate-app-caller-"));
  try {
    const script = join(process.cwd(), "..", "scripts", "rs");
    const result = spawnSync(script, ["help"], {
      cwd: caller,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /scripts\/rs setup/);
    assert.match(result.stdout, /--runtime <absolute-path>/);
    assert.match(result.stdout, /room create/);
    assert.match(result.stdout, /--client codex/);
    assert.match(result.stdout, /workspace set <absolute-path>/);
  } finally {
    rmSync(caller, { recursive: true, force: true });
  }
});

test("workspace set command persists one canonical Agent workspace root", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-agent-configure-"));
  try {
    const workspaceRoot = join(repo, "agents");
    let output = "";
    const code = await runLocalApp(repo, [
      "workspace",
      "set",
      workspaceRoot
    ], {}, {
      write: (text) => {
        output += text;
      }
    });
    assert.equal(code, 0);
    assert.match(output, /Agent workspace root configured/);
    assert.doesNotMatch(output, /credential|verifier|secret/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("global --runtime isolates Local configuration from the checkout", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-runtime-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-runtime-selected-"));
  try {
    const workspaceRoot = join(runtime, "agents");
    const code = await runLocalApp(repo, [
      "--runtime",
      runtime,
      "workspace",
      "set",
      workspaceRoot
    ]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(join(runtime, "agent-config.json"), "utf8"))
      .workspaceRoot, realpathSync(workspaceRoot));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("interactive CLI logs in one Device and adds multiple Agents", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-interactive-"));
  const answers = ["", "1", "", "alice", "1", "1", "bob", "1", "6"];
  const createdAgents: string[] = [];
  let pairingRequests = 0;
  let deviceId = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, string>;
    if (url.pathname === "/api/device-pairings" && init?.method === "POST") {
      pairingRequests += 1;
      deviceId = body.deviceId ?? "";
      return Response.json({
        pairingId: "pairing-id",
        deviceId,
        verificationUri: "https://identity.example/device",
        userCode: "ABCD-EFGH",
        expiresAt: "2099-01-01T00:00:00.000Z",
        pollIntervalMilliseconds: 100
      }, { status: 201 });
    }
    if (url.pathname === "/api/device-pairings/pairing-id" && init?.method === "GET") {
      return Response.json({
        pairingId: "pairing-id",
        deviceId,
        status: "approved",
        expiresAt: "2099-01-01T00:00:00.000Z",
        pollIntervalMilliseconds: 100
      });
    }
    if (url.pathname === "/api/device-pairings/pairing-id/redeem") {
      return Response.json({
        credentialId: "device-credential-id",
        credential: "device-credential-id.device-secret",
        device: deviceSummary(deviceId)
      });
    }
    if (url.pathname === "/api/agents" && init?.method === "POST") {
      const name = body.name ?? "";
      createdAgents.push(name);
      return Response.json({
        agent: agentSummary(name, deviceId, false),
        enrollment: {
          id: `enrollment-${name}`,
          agentId: `agent-${name}`,
          deviceId,
          placementId: `placement-${name}`,
          status: "issued",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      }, { status: 201 });
    }
    const enrollment = /^\/api\/agent-enrollments\/enrollment-([^/]+)\/redeem$/
      .exec(url.pathname)?.[1];
    if (enrollment !== undefined) {
      return Response.json({
        credentialId: `agent-credential-${enrollment}`,
        credential: `agent-credential-${enrollment}.agent-secret`,
        agent: agentSummary(enrollment, deviceId, true)
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  let output = "";
  try {
    const code = await runLocalApp(repo, [], {}, {
      write: (text) => {
        output += text;
      }
    }, {
      prompts: {
        question: async () => answers.shift() ?? "6",
        close: () => {}
      },
      fetch: fakeFetch,
      sleep: async () => {}
    });
    assert.equal(code, 0);
    assert.equal(pairingRequests, 1);
    assert.deepEqual(createdAgents, ["alice", "bob"]);
    assert.match(output, /Device paired/);
    assert.match(output, /Agent: alice/);
    assert.match(output, /Client: codex/);
    assert.match(output, /Agent: bob/);
    assert.equal(output.match(/Client: codex/g)?.length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("device login is a zero-argument authentication command", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-device-login-cli-"));
  try {
    await assert.rejects(() => runLocalApp(repo, [
      "device",
      "login",
      "--server",
      "http://localhost:4100"
    ]), /unexpected arguments/);
    await assert.rejects(
      () => runLocalApp(repo, ["device", "login"]),
      /requires ROLLERSKATE_SERVER_URL or a server saved in this runtime/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Room Agent environment keeps executable lookup without inheriting secrets", () => {
  assert.deepEqual(roomAgentEnvironment({
    HOME: "/test/home",
    PATH: "/test/bin:/usr/bin",
    CODEX_HOME: "/test/codex",
    ROLLERSKATE_TEST_SECRET: "must-not-leak"
  }), {
    HOME: "/test/home",
    PATH: "/test/bin:/usr/bin",
    CODEX_HOME: "/test/codex"
  });
});

function deviceSummary(deviceId: string): object {
  return {
    id: deviceId,
    name: "Test Laptop",
    status: "active",
    createdAt: "2026-07-22T00:00:00.000Z",
    human: { id: "human-id", displayName: "Example Human", isAdmin: true }
  };
}

function agentSummary(name: string, deviceId: string, active: boolean): object {
  return {
    id: `agent-${name}`,
    name,
    status: active ? "active" : "provisioning",
    createdAt: "2026-07-22T00:00:00.000Z",
    owner: { id: "human-id", displayName: "Example Human", isAdmin: true },
    operator: { id: "human-id", displayName: "Example Human", isAdmin: true },
    placement: {
      id: `placement-${name}`,
      deviceId,
      state: active ? "active" : "pending",
      generation: 1,
      createdAt: "2026-07-22T00:00:00.000Z",
      ...(active ? { activatedAt: "2026-07-22T00:00:01.000Z" } : {})
    },
    credentialStatus: active ? "active" : "pending"
  };
}
