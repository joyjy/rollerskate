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
import { loadLocalRuntime } from "../src/application/runtime-config.js";

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
    assert.match(result.stdout, /agent rename <handle> <new-handle>/);
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
      "agent", "create", "alice", "--client", "codex"
    ], {}, {
      write: (text) => {
        output += text;
      }
    });
    assert.equal(code, 0);
    assert.match(output, /Agent: @alice/);
    assert.match(output, /Client: codex/);
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
