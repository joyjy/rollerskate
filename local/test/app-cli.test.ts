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
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

import { roomAgentEnvironment, runLocalApp } from "../src/entrypoints/cli/main.js";
import {
  loadLocalRuntime,
  runtimePaths
} from "../src/infrastructure/runtime/config.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

 test("setup command accepts non-interactive environment without leaking its token", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-app-cli-"));
  const runtime = join(repo, "runtime");
  try {
    const codex = join(repo, "codex");
    writeFileSync(codex, "fixture");
    chmodSync(codex, 0o700);
    let output = "";
    const code = await runLocalApp(repo, ["--runtime", runtime, "setup"], {
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
    assert.equal(loadLocalRuntime(repo, runtime).matrixAccessToken, "secret-token");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repo-local script resolves Rollerskate independently of caller cwd", () => {
  const caller = mkdtempSync(join(tmpdir(), "rollerskate-app-caller-"));
  try {
    const script = join(process.cwd(), "..", "scripts", "rs");
    const result = spawnSync(script, ["--help"], {
      cwd: caller,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /scripts\/rs --help/);
    assert.match(result.stdout, /--runtime <absolute-path>/);
    assert.match(result.stdout, /subscription add <json-file>/);
    assert.match(result.stdout, /schedule create\|update\|list\|inspect/);
    assert.match(result.stdout, /run start\|list\|inspect\|trace\|cancel/);
    assert.doesNotMatch(result.stdout, /scripts\/rs (?:steward|review) /);
    assert.match(result.stdout, /agent rename <handle> <new-handle>/);
    assert.match(result.stdout, /notice list \[--limit <1-1000>\]/);
    assert.match(result.stdout, /notice mark-read\|ack <notice-id>/);
    assert.doesNotMatch(result.stdout, /workspace set|room create|device login|subscription.*revoke/);
  } finally {
    rmSync(caller, { recursive: true, force: true });
  }
});

test("help has one explicit form", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-help-cli-"));
  try {
    assert.equal(await runLocalApp(repo, ["--help"]), 0);
    await assert.rejects(() => runLocalApp(repo, ["help"]), /unknown command/);
    await assert.rejects(() => runLocalApp(repo, ["-h"]), /unknown command/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("workspace set command persists one canonical Agent workspace root", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-agent-configure-"));
  const runtime = join(repo, "runtime");
  try {
    const workspaceRoot = join(repo, "agents");
    let output = "";
    const code = await runLocalApp(repo, [
      "--runtime",
      runtime,
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

test("Local Agent CLI requires an explicit client", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-agent-create-cli-"));
  const runtime = join(repo, "runtime");
  let output = "";
  try {
    await assert.rejects(() => runLocalApp(repo, [
      "--runtime", runtime, "agent", "create", "alice"
    ]), /--client/);
    const code = await runLocalApp(repo, [
      "--runtime", runtime,
      "agent", "create", "alice", "--client", "claude-code"
    ], {}, {
      write: (text) => {
        output += text;
      }
    });
    assert.equal(code, 0);
    assert.match(output, /Agent: @alice/);
    assert.match(output, /Client: claude-code/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Local Agent CLI persists, replaces and clears per-Agent launch args", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-agent-launch-args-cli-"));
  const runtime = join(repo, "runtime");
  let output = "";
  try {
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime,
      "agent", "create", "kimi",
      "--client", "kimi-code",
      "--launch-arg", "--model",
      "--launch-arg", "kimi-code/kimi-for-coding"
    ], {}, { write(text) { output += text; } }), 0);
    assert.match(output, /Client: kimi-code/);
    assert.match(output, /Launch args: \["--model","kimi-code\/kimi-for-coding"\]/);

    output = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime,
      "agent", "configure", "kimi",
      "--launch-arg", "--agent",
      "--launch-arg", "researcher"
    ], {}, { write(text) { output += text; } }), 0);
    assert.match(output, /Launch args: \["--agent","researcher"\]/);

    output = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime, "agent", "configure", "kimi"
    ], {}, { write(text) { output += text; } }), 0);
    assert.match(output, /Launch args: \[\]/);

    await assert.rejects(() => runLocalApp(repo, [
      "--runtime", runtime,
      "agent", "configure", "kimi",
      "--launch-arg", "--session=ses_foreign"
    ]), /controlled by the kimi-code adapter/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("notice CLI lists and inspects durable macOS notification history", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-notice-cli-"));
  const runtime = join(repo, "runtime");
  const store = new RuntimeStore(runtimePaths(repo, runtime).database);
  let output = "";
  try {
    const destination = store.putDestination({
      kind: "macos-notification",
      address: {
        title: "Pipeline complete",
        subscriptionId: "sub_fixture"
      },
      at: "2026-07-25T01:00:00.000Z"
    });
    const request = store.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "notice-history" },
      agentId: "agent-1",
      prompt: "persist a result",
      destinationIds: [destination.destinationId],
      createdAt: "2026-07-25T01:00:01.000Z"
    });
    const agentExecution = store.claimDueExecutions(
      1,
      "2026-07-25T01:00:02.000Z"
    )[0]!;
    const result = store.completeExecution(agentExecution.executionId, {
      adapterId: "fixture",
      workspace: repo,
      providerSessionId: "provider-notice",
      output: `saved ${"x".repeat(200)}`
    }, "2026-07-25T01:00:03.000Z");
    assert.equal(result?.type, "agent.result");
    const resultExecution = store.claimDueExecutions(
      1,
      "2026-07-25T01:00:04.000Z"
    )[0]!;
    const delivery = store.completeResultExecution(
      resultExecution.executionId,
      "2026-07-25T01:00:05.000Z"
    )[0]!;
    const claimed = store.claimDueDeliveries(
      1,
      "2026-07-25T01:00:06.000Z"
    )[0]!;
    store.deliverySucceeded(
      claimed.deliveryId,
      "macos-notification:fixture",
      "2026-07-25T01:00:07.000Z"
    );
    store.close();

    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime, "notice", "list", "--limit", "1"
    ], {}, { write(text) { output += text; } }), 0);
    const history = JSON.parse(output) as Array<{
      noticeId: string;
      title: string;
      summary: string;
      outcome: string;
      deliveryStatus: string;
      references: { deliveryId: string };
    }>;
    assert.equal(history.length, 1);
    assert.equal(history[0]?.noticeId, `ntc1_${delivery.deliveryId}`);
    assert.equal(history[0]?.references.deliveryId, delivery.deliveryId);
    assert.equal(history[0]?.deliveryStatus, "delivered");
    assert.equal(history[0]?.title, "Pipeline complete");
    assert.equal(history[0]?.outcome, "succeeded");
    assert.equal(history[0]?.summary, `saved ${"x".repeat(200)}`);

    output = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime, "notice", "inspect", `ntc1_${delivery.deliveryId}`
    ], {}, { write(text) { output += text; } }), 0);
    const inspected = JSON.parse(output) as {
      summary: {
        noticeId: string;
        readAt: string | null;
        availableActions: { markRead: boolean; acknowledge: boolean };
      };
    };
    assert.equal(inspected.summary.noticeId, `ntc1_${delivery.deliveryId}`);
    assert.equal(inspected.summary.readAt, null);
    assert.deepEqual(inspected.summary.availableActions, {
      markRead: true,
      acknowledge: true
    });

    output = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime, "notice", "ack", `ntc1_${delivery.deliveryId}`
    ], {}, { write(text) { output += text; } }), 0);
    const acknowledged = JSON.parse(output) as {
      summary: {
        readAt: string | null;
        acknowledgedAt: string | null;
        availableActions: { markRead: boolean; acknowledge: boolean };
      };
    };
    assert.ok(acknowledged.summary.readAt);
    assert.ok(acknowledged.summary.acknowledgedAt);
    assert.deepEqual(acknowledged.summary.availableActions, {
      markRead: false,
      acknowledge: false
    });

    output = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime, "notice", "rebuild"
    ], {}, { write(text) { output += text; } }), 0);
    assert.deepEqual(JSON.parse(output), {
      projected: 1,
      preservedStates: 1
    });
    await assert.rejects(() => runLocalApp(repo, [
      "--runtime", runtime, "notice", "list", "--limit", "0"
    ]), /between 1 and 1000/);
    await assert.rejects(() => runLocalApp(repo, [
      "--runtime", runtime, "notice", "inspect", delivery.deliveryId
    ]), /deterministic Delivery Notice ID/);
    assert.equal(request.status, "accepted");
  } finally {
    try {
      store.close();
    } catch {
      // The main path closes before CLI opens the same database.
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Chat CLI posts messages, controls scoped presence, reads status, and rotates a Session",
  async () => {
    const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-cli-"));
    const runtime = join(repo, "runtime");
    let output = "";
    try {
      await runLocalApp(repo, [
        "--runtime", runtime, "agent", "create", "alice", "--client", "codex"
      ], {}, { write() {} });
      assert.equal(await runLocalApp(repo, [
        "--runtime", runtime, "chat", "post", "@alice inspect this"
      ], {}, { write(text) { output += text; } }), 0);
      const posted = JSON.parse(output) as {
        eventId: string;
        status: string;
        target: { handleSnapshot: string };
      };
      assert.equal(posted.status, "queued");
      assert.equal(posted.target.handleSnapshot, "alice");

      output = "";
      assert.equal(await runLocalApp(repo, [
        "--runtime", runtime, "chat", "history"
      ], {}, { write(text) { output += text; } }), 0);
      const history = JSON.parse(output) as {
        topicId: string;
        items: Array<{ eventId: string; body: string }>;
        hasEarlier: boolean;
      };
      assert.ok(history.items.some(
        (event) => event.eventId === posted.eventId && event.body === "@alice inspect this"
      ));
      assert.equal(history.hasEarlier, false);
      await assert.rejects(() => runLocalApp(repo, [
        "--runtime", runtime, "chat", "history", "--limit", "201"
      ]), /between 1 and 200/u);

      output = "";
      assert.equal(await runLocalApp(repo, [
        "--runtime", runtime, "chat", "status"
      ], {}, { write(text) { output += text; } }), 0);
      const status = JSON.parse(output) as {
        agents: Array<{ handle: string; status: string }>;
      };
      assert.deepEqual(status.agents.map(
        (agent) => ({ handle: agent.handle, status: agent.status })
      ), [{ handle: "alice", status: "active" }]);

      output = "";
      assert.equal(await runLocalApp(repo, [
        "--runtime", runtime,
        "chat", "presence", "set", "alice",
        "--scope", "global",
        "--mode", "snoozed",
        "--until", "2030-07-25T02:00:00.000Z",
        "--wake-keyword", "urgent",
        "--wake-keyword", "review"
      ], {}, { write(text) { output += text; } }), 0);
      const configured = JSON.parse(output) as {
        agentId: string;
        handle: string;
        presence: {
          scope: string;
          mode: string;
          until: string;
          wakeKeywords: string[];
        };
      };
      assert.match(configured.agentId, /^prn_/);
      assert.equal(configured.handle, "alice");
      assert.deepEqual(configured.presence, {
        scope: "global",
        mode: "snoozed",
        until: "2030-07-25T02:00:00.000Z",
        wakeKeywords: ["urgent", "review"]
      });

      output = "";
      assert.equal(await runLocalApp(repo, [
        "--runtime", runtime, "chat", "status"
      ], {}, { write(text) { output += text; } }), 0);
      const snoozed = JSON.parse(output) as {
        agents: Array<{ handle: string; global: { mode: string; wakeKeywords: string[] } }>;
      };
      assert.deepEqual(snoozed.agents[0]?.global, {
        scope: "global",
        mode: "snoozed",
        until: "2030-07-25T02:00:00.000Z",
        wakeKeywords: ["urgent", "review"]
      });

      output = "";
      assert.equal(await runLocalApp(repo, [
        "--runtime", runtime,
        "chat", "presence", "set", "alice",
        "--scope", "global",
        "--mode", "available"
      ], {}, { write(text) { output += text; } }), 0);
      await assert.rejects(() => runLocalApp(repo, [
        "--runtime", runtime,
        "chat", "presence", "set", "alice",
        "--scope", "topic",
        "--mode", "snoozed"
      ]), /requires --until/);

      output = "";
      assert.equal(await runLocalApp(repo, [
        "--runtime", runtime, "chat", "session", "new", "alice"
      ], {}, { write(text) { output += text; } }), 0);
      const rotated = JSON.parse(output) as {
        agentId: string;
        handle: string;
        generation: number;
        currentSessionId: null;
      };
      assert.match(rotated.agentId, /^prn_/);
      assert.deepEqual({
        handle: rotated.handle,
        generation: rotated.generation,
        currentSessionId: rotated.currentSessionId
      }, {
        handle: "alice",
        generation: 2,
        currentSessionId: null
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

test("device login is a zero-argument authentication command", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-device-login-cli-"));
  const runtime = join(repo, "runtime");
  try {
    await assert.rejects(() => runLocalApp(repo, [
      "--runtime",
      runtime,
      "device",
      "login",
      "--server",
      "http://localhost:4100"
    ]), /unexpected arguments/);
    await assert.rejects(
      () => runLocalApp(repo, ["--runtime", runtime, "device", "login"]),
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

test("start logs graceful shutdown signals before exiting", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const repo = mkdtempSync(join(tmpdir(), `rollerskate-signal-${signal.toLowerCase()}-`));
    const runtime = join(repo, "runtime");
    const port = await unusedLoopbackPort();
    const script = join(process.cwd(), "..", "scripts", "rs");
    const child = spawn(script, [
      "--runtime",
      runtime,
      "start",
      "--no-open",
      "--ui-port",
      String(port)
    ], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitForOutput(child, "Rollerskate UI:");
      assert.equal(child.kill(signal), true);
      const [code, exitSignal] = await once(child, "exit") as [
        number | null,
        NodeJS.Signals | null
      ];
      assert.equal(code, 0, stderr);
      assert.equal(exitSignal, null);
      const log = readFileSync(join(runtime, "logs", "daemon.log"), "utf8");
      assert.match(log, new RegExp(`Rollerskate received ${signal}; stopping\\.`));
      assert.match(log, /Rollerskate stopped after \d+ Runtime cycle\(s\)\./);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback server did not expose an IP port");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string
): Promise<void> {
  child.stdout.setEncoding("utf8");
  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${expected}; stdout: ${stdout}`));
    }, 10_000);
    const onData = (chunk: string): void => {
      stdout += chunk;
      if (stdout.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(
        `process exited before ${expected}; code=${String(code)} signal=${String(signal)}`
      ));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}
