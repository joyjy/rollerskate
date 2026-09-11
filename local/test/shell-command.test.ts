import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { runtimeArtifactRevision } from "../src/infrastructure/runtime/revision.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { bootstrapLocalFoundation } from "../src/infrastructure/sqlite/foundation-store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { inspectCommand } from "../src/application/command/query.js";
import { desktopSubscriptionDeliveries } from "../src/application/subscription/desktop-control.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { SubscriptionRuntime } from "../src/capabilities/subscription/runtime.js";
import { DeterministicApplicationActionRegistry } from "../src/application/proactive/action-registry.js";
import { codexDesktopPushAction } from "../src/application/proactive/codex-desktop-action.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../src/entrypoints/cli/main.js", import.meta.url));
import { deterministicRunId } from "../src/modules/run/intent.js";
import { observeOnlyAction } from "../src/application/subscription/observation-control.js";

import { desktopTargetFixture } from "./helpers/codex-desktop-target.js";

const threadId = "01a08e63-109a-7452-9d23-f9fa9f236343";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rs-shell-command-"));
  const paths = runtimePaths(repoRoot, root);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths);
  const heartbeat = (revision = runtimeArtifactRevision(repoRoot)) => writeFileSync(paths.loopState, JSON.stringify({
    schemaVersion: 1, pid: process.pid, status: "running", updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), runtimeRevision: revision, cycles: 0, paused: false, phase: "idle"
  }), { mode: 0o600 });
  heartbeat();
  const desktop = desktopTargetFixture(t, root, threadId);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const start = async (id: string, argv: string[], options: string[] = []) => {
    await desktop.ready;
    return invoke([
    "--runtime", root, "run", "start", "--id", id, "--return-to", `codex-desktop:${threadId}`,
    "--cwd", root, "--title", `Command ${id}`, ...options, "--", ...argv
  ], { ...process.env, ROLLERSKATE_CODEX_IPC_SOCKET: desktop.path });
  };
  return { root, paths, heartbeat, start, desktop };
}

async function invoke(args: string[], env = process.env) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}

async function completed(root: string, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = inspectCommand(repoRoot, deterministicRunId(id), root);
    if (receipt.state === "completed") return receipt;
    await delay(25);
  }
  throw new Error(`No terminal receipt: ${id}`);
}

function poller(root: string) {
  const database = openRuntimeDatabase(runtimePaths(repoRoot, root).database);
  const actions = new DeterministicApplicationActionRegistry(database, [codexDesktopPushAction, observeOnlyAction]);
  const store = new SubscriptionStore(database, { migrate: false, applicationActions: actions });
  const runtime = new SubscriptionRuntime({ databasePath: runtimePaths(repoRoot, root).database, store });
  return { database, runtime, store };
}

test("CLI returns before completion; inherited cwd/argv, immutable command identity, exact Desktop observation, no Agent execution", async t => {
  const f = fixture(t);
  const script = "const fs=require('node:fs'); fs.appendFileSync('calls','x'); console.log(process.argv[1]); setTimeout(()=>{},800)";
  const started = await f.start("pull-fixture", [process.execPath, "-e", script, "literal $(touch injected) and spaces"]);
  assert.equal(started.code, 0, started.stderr);
  const launch = JSON.parse(started.stdout).launch;
  assert.ok(f.desktop.requests.includes("thread-owner-discovery"));
  assert.ok(f.desktop.requests.every(method => ["initialize", "thread-owner-discovery"].includes(method)));
  assert.equal(launch.state, "started");
  assert.equal(inspectCommand(repoRoot, deterministicRunId("pull-fixture"), f.root).state, "running");
  f.heartbeat();
  const duplicate = await f.start("pull-fixture", [process.execPath, "-e", script, "literal $(touch injected) and spaces"]);
  assert.equal(duplicate.code, 0, duplicate.stdout);
  assert.equal(JSON.parse(duplicate.stdout).status, "already_admitted");
  const receipt = await completed(f.root, "pull-fixture");
  assert.equal(receipt.outcome, "success");
  assert.equal(receipt.exitCode, 0);
  assert.equal(readFileSync(join(f.root, "calls"), "utf8"), "x");
  assert.equal(existsSync(join(f.root, "injected")), false);
  assert.match(readFileSync(receipt.logPath, "utf8"), /literal \$\(touch injected\) and spaces/);
  const p = poller(f.root);
  try {
    const result = await p.runtime.runCycle(new AbortController().signal, new Date(Date.now() + 6000).toISOString());
    assert.deepEqual(result.failed, []);
    const [delivery] = desktopSubscriptionDeliveries(repoRoot, launch.subscriptionId, f.root);
    assert.ok(delivery);
    const body = JSON.parse(String(delivery.payload.body));
    assert.equal(body.observation.facts.commandId, deterministicRunId("pull-fixture"));
    assert.equal(body.observation.facts.exitCode, 0);
    assert.equal(body.observation.facts.logPath, receipt.logPath);
    assert.equal((p.database.prepare("SELECT count(*) AS n FROM executions").get() as { n: number }).n, 0);
    assert.deepEqual(new RuntimeStore(p.database, { migrate: false }).destination(delivery.destinationId)?.address, { threadId });
    await p.runtime.runCycle(new AbortController().signal, new Date(Date.now() + 12000).toISOString());
    assert.equal(desktopSubscriptionDeliveries(repoRoot, launch.subscriptionId, f.root).length, 1);
  } finally { p.database.close(); }
});

test("nonzero exit and signal produce failure/cancellation receipts without replay", async t => {
  const f = fixture(t);
  for (const [id, argv, outcome, exitCode] of [
    ["failed", [process.execPath, "-e", "process.exit(7)"], "failure", 7],
    ["cancelled", [process.execPath, "-e", "process.kill(process.pid,'SIGTERM')"], "cancelled", null]
  ] as const) {
    f.heartbeat();
    const result = await f.start(id, [...argv]);
    assert.equal(result.code, 0, result.stdout);
    const receipt = await completed(f.root, id);
    assert.equal(receipt.outcome, outcome);
    assert.equal(receipt.exitCode, exitCode);
  }
});

test("invalid target, stale Runtime, and invalid timeout fail before command side effects", async t => {
  const f = fixture(t);
  const argv = [process.execPath, "-e", "require('node:fs').writeFileSync('unexpected','x')"];
  assert.notEqual((await f.start("bad-budget", argv, ["--timeout", "0"])).code, 0);
  const invalid = await invoke(["--runtime", f.root, "run", "start", "--id", "bad-target", "--return-to", "recent",
    "--cwd", f.root, "--title", "invalid", "--", ...argv]);
  assert.notEqual(invalid.code, 0);
  await f.desktop.ready;
  const unloaded = await invoke(["--runtime", f.root, "run", "start", "--id", "unloaded-target", "--return-to",
    "codex-desktop:00000000-0000-7000-8000-000000000001", "--cwd", f.root, "--title", "unloaded", "--", ...argv],
    {...process.env, ROLLERSKATE_CODEX_IPC_SOCKET:f.desktop.path});
  assert.equal(unloaded.code,2);
  assert.equal(JSON.parse(unloaded.stdout).diagnostics[0].code,"DESTINATION_UNAVAILABLE");
  assert.ok(f.desktop.requests.every(method => ["initialize", "thread-owner-discovery"].includes(method)));
  f.heartbeat("rt1_wrong");
  assert.match((await f.start("stale", argv)).stdout, /Runtime must be running and fresh/);
  assert.equal(existsSync(join(f.root, "unexpected")), false);
  assert.equal(existsSync(join(f.root, "commands")), false);
});

test("expiry ends observation without killing the command or reporting success", async t => {
  const f = fixture(t);
  const result = await f.start("slow-install", [process.execPath, "-e", "setTimeout(()=>console.log('finished'),1800)"], ["--timeout", "1"]);
  assert.equal(result.code, 0, result.stderr);
  const launch = JSON.parse(result.stdout).launch;
  const p = poller(f.root);
  try {
    await p.runtime.runCycle(new AbortController().signal, new Date(Date.now() + 2000).toISOString());
    const [delivery] = desktopSubscriptionDeliveries(repoRoot, launch.subscriptionId, f.root);
    assert.ok(delivery);
    assert.equal(JSON.parse(String(delivery.payload.body)).observation.facts.status, "expired");
    assert.equal((await completed(f.root, "slow-install")).outcome, "success");
    await p.runtime.runCycle(new AbortController().signal, new Date(Date.now() + 5000).toISOString());
    assert.equal(desktopSubscriptionDeliveries(repoRoot, launch.subscriptionId, f.root).length, 1);
  } finally { p.database.close(); }
});

test("a mismatched source receipt cannot become success, and short budgets permit a probe before expiry", async t => {
  const f = fixture(t);
  const result = await f.start("receipt-identity", [process.execPath, "-e", "process.exit(0)"], ["--timeout", "1"]);
  assert.equal(result.code, 0, result.stderr);
  const launch = JSON.parse(result.stdout).launch;
  const receipt = await completed(f.root, "receipt-identity");
  writeFileSync(receipt.receiptPath, JSON.stringify({ ...receipt, commandId: "different-command" }));
  const p = poller(f.root);
  try {
    const source = p.store.require(launch.subscriptionId);
    assert.ok(source.intervalMilliseconds < source.maxWaitMilliseconds);
    const result = await p.runtime.runCycle(new AbortController().signal, source.nextPollAt);
    assert.equal(result.failed.length, 1);
    assert.equal(desktopSubscriptionDeliveries(repoRoot, launch.subscriptionId, f.root).length, 0);
    await p.runtime.runCycle(new AbortController().signal, new Date(Date.now() + 3000).toISOString());
    const [delivery] = desktopSubscriptionDeliveries(repoRoot, launch.subscriptionId, f.root);
    assert.equal(JSON.parse(String(delivery!.payload.body)).observation.facts.status, "expired");
  } finally { p.database.close(); }
});
