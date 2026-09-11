import { pathToFileURL } from "node:url";
import { registerFileSubscription } from "../src/application/subscription/file-control.js";
import { inspectContinuousSubscriptionView } from "../src/application/subscription/continuous.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { ExternalWorkflowRuntime } from "../src/application/proactive/external-workflow-runtime.js";
import { loadOwnerExternalWorkflowRegistry } from "../src/application/proactive/external-workflow-registry.js";
import { HostCallbackKernel } from "../src/infrastructure/callback/host-kernel.js";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { FileEventListener, parseFileEventSource } from "../src/capabilities/subscription/file-source.js";
import { FileSubscriptionSources } from "../src/capabilities/subscription/file-source-runtime.js";
import { ContinuousSubscriptionStore } from "../src/capabilities/subscription/continuous-store.js";
import { migrateLocalDatabase } from "../src/infrastructure/sqlite/schema/index.js";
import { withImmediateTransaction } from "../src/infrastructure/sqlite/transaction.js";
import { ExternalWorkflowStore } from "../src/infrastructure/proactive/external-workflow-store.js";
import { DeterministicApplicationActionRegistry } from "../src/application/proactive/action-registry.js";
import { parseProactiveTarget, type ExternalWorkflowProactiveTarget } from "../src/modules/proactive/target.js";
import { localId } from "../src/core/id.js";

const signal = new AbortController().signal;
const source = (root: string) => parseFileEventSource({ kind: "file", root, recursive: true,
  suffixes: [".md"], exclude: ["ignored"], debounceMilliseconds: 100, maxDelayMilliseconds: 250 });
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("native event did not arrive"); await delay(10); }
}

test("native file listener covers startup, atomic replacement, creation, deletion and exclusion", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rs-file-native-")));
  const listener = new FileEventListener(source(root));
  try {
    await until(() => listener.due() !== undefined);
    listener.accepted(listener.due()!);
    writeFileSync(join(root, "a.tmp"), "a");
    renameSync(join(root, "a.tmp"), join(root, "a.md"));
    await until(() => listener.due() !== undefined);
    listener.accepted(listener.due()!);
    writeFileSync(join(root, "a.md"), "changed");
    await until(() => listener.due() !== undefined);
    listener.accepted(listener.due()!);
    rmSync(join(root, "a.md"));
    await until(() => listener.due() !== undefined);
    listener.accepted(listener.due()!);
    mkdirSync(join(root, "ignored"));
    writeFileSync(join(root, "ignored", "hidden.md"), "ignored");
    await delay(100);
    assert.equal(listener.due(), undefined);
  } finally { listener.close(); rmSync(root, { recursive: true, force: true }); }
});

test("continuous file source preserves events during pending execution and checkpoints only success", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rs-file-pending-")));
  const database = new DatabaseSync(":memory:");
  migrateLocalDatabase(database);
  const workflows = new ExternalWorkflowStore(database);
  const store = new ContinuousSubscriptionStore(database, { externalWorkflows: workflows });
  const files = new FileSubscriptionSources();
  const id = localId("sub");
  const target = parseProactiveTarget({ schemaVersion: "ProactiveTarget@1", kind: "external_workflow",
    workflow: { schemaVersion: "ExternalWorkflowTarget@1", workflowRef: "workflow:test/sync@1",
      registrationDigest: `sha256:${"a".repeat(64)}`, input: {},
      executionPolicy: { schemaVersion: "ExternalWorkflowExecutionPolicy@1", maxAttempts: 2, retryBackoffMilliseconds: 1000 } }
  }) as ExternalWorkflowProactiveTarget;
  try {
    withImmediateTransaction(database, () => store.createFileInTransaction({ schemaVersion: "ContinuousSubscriptionDefinition@4",
      revision: 1, subscriptionId: id, title: "files", source: source(root), target }));
    const cycle = () => files.runCycle(store, signal, new Date().toISOString());
    cycle();
    await until(() => { cycle(); return store.require(id).pendingOccurrenceKey !== undefined; });
    const first = store.require(id).pendingOccurrenceKey!;
    assert.equal(store.require(id).nextPollAt, null);
    assert.equal(store.due().length, 0);
    writeFileSync(join(root, "during.md"), "new");
    await delay(100);
    cycle();
    assert.equal(store.require(id).pendingOccurrenceKey, first);
    const claim = workflows.claimDue("test", new Date().toISOString(), 1)[0]!;
    workflows.markEffectStarted(claim.execution.executionId, "test", claim.leaseToken);
    workflows.succeed(claim.execution.executionId, "test", claim.leaseToken, { stdout: "done", stderr: "" });
    store.reconcileExternalWorkflows();
    assert.equal(store.require(id).checkpointOccurrenceKey, first);
    await until(() => { cycle(); return store.require(id).pendingOccurrenceKey !== undefined; });
    const second = store.require(id).pendingOccurrenceKey!;
    assert.ok(second && second !== first);
    const next = workflows.claimDue("test", new Date().toISOString(), 1)[0]!;
    workflows.markEffectStarted(next.execution.executionId, "test", next.leaseToken);
    workflows.failAfterEffect(next.execution.executionId, "test", next.leaseToken, { outcome: "failed", error: "exit 1", stdout: "", stderr: "" });
    store.reconcileExternalWorkflows();
    assert.equal(store.require(id).status, "blocked");
    assert.equal(store.require(id).checkpointOccurrenceKey, first);
    assert.equal(store.require(id).pendingOccurrenceKey, second);
    assert.equal((database.prepare("SELECT count(*) AS n FROM events").get() as {n:number}).n, 0);
    assert.equal((database.prepare("SELECT count(*) AS n FROM executions").get() as {n:number}).n, 0);
    cycle();
    assert.equal(store.require(id).fileListener?.status, "stopped");
  } finally { files.close(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("file source retries listener setup, coalesces bursts, survives restart and pause/resume", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rs-file-restart-")));
  const database = new DatabaseSync(":memory:");
  migrateLocalDatabase(database);
  let effects = 0;
  const actions = new DeterministicApplicationActionRegistry(database, [{ ref: "action:test/sync@1", inputSchema: "Empty@1",
    parseInput: (value) => value, executeInTransaction: () => { effects++; return { status: "succeeded", summary: "done" }; } }]);
  const store = new ContinuousSubscriptionStore(database, { applicationActions: actions });
  const id = localId("sub");
  let attempts = 0;
  let files = new FileSubscriptionSources((scope) => { if (attempts++ === 0) throw new Error("watch unavailable"); return new FileEventListener(scope); });
  try {
    withImmediateTransaction(database, () => store.createFileInTransaction({ schemaVersion: "ContinuousSubscriptionDefinition@4",
      revision: 1, subscriptionId: id, title: "files", source: source(root), target: actions.compileTarget("action:test/sync@1", {}) }));
    const cycle = () => files.runCycle(store, signal, new Date().toISOString());
    cycle();
    assert.equal(store.require(id).fileListener?.status, "degraded");
    await until(() => { cycle(); return effects === 1; });
    for (let i = 0; i < 20; i++) writeFileSync(join(root, "burst.md"), String(i));
    await until(() => { cycle(); return effects === 2; });
    await delay(100); cycle(); assert.equal(effects, 2);
    store.setStatus(id, "pause"); cycle();
    writeFileSync(join(root, "paused.md"), "paused");
    await delay(100); cycle(); assert.equal(effects, 2);
    store.setStatus(id, "resume");
    await until(() => { cycle(); return effects === 3; });
    files.close();
    writeFileSync(join(root, "offline.md"), "offline");
    files = new FileSubscriptionSources();
    await until(() => { cycle(); return effects === 4; });
    store.setStatus(id, "cancel"); cycle();
    assert.equal(store.require(id).fileListener?.status, "stopped");
  } finally { files.close(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("file source rejects path escape and closes partly initialized listeners", () => {
  assert.throws(() => parseFileEventSource({ ...source("/tmp"), exclude: ["../escape"] }), /relative/);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rs-file-close-")));
  let closed = false;
  let calls = 0;
  const watchPort = ((..._args: unknown[]) => {
    if (calls++ > 0) throw new Error("second listener failed");
    return { on() {}, close() { closed = true; } };
  }) as unknown as typeof watch;
  try { assert.throws(() => new FileEventListener(source(root), watchPort), /second listener/); assert.equal(closed, true); }
  finally { rmSync(root, { recursive: true, force: true }); }
});


test("Owner file registration and query execute a registered workflow without a Run", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rs-file-owner-")));
  const runtime = join(root, "runtime");
  const watched = join(root, "watched");
  mkdirSync(runtime); mkdirSync(watched);
  const paths = runtimePaths(root, runtime);
  initializeRuntimeSchema(paths.database);
  const executable = join(root, "sync.sh");
  writeFileSync(executable, "#!/bin/sh\nprintf 'file-sync-complete'\n");
  chmodSync(executable, 0o700);
  writeFileSync(paths.externalWorkflows, JSON.stringify({ schemaVersion: "OwnerExternalWorkflowRegistry@1", workflows: [{
    schemaVersion: "OwnerExternalWorkflowRegistration@1", ref: "workflow:test/files@1", inputSchema: "Empty@1", fixedInput: {},
    command: { executable: pathToFileURL(executable).href, arguments: [], cwd: pathToFileURL(root).href,
      environment: {}, timeoutMilliseconds: 1000, maxOutputBytes: 1024 },
    authority: { filesystemRoots: [pathToFileURL(root).href], networkAccess: true },
    retry: { maxAttempts: 2, backoffMilliseconds: 1000 }
  }] }));
  chmodSync(paths.externalWorkflows, 0o600);
  const database = new DatabaseSync(paths.database);
  const workflows = new ExternalWorkflowStore(database);
  const store = new ContinuousSubscriptionStore(database, { externalWorkflows: workflows });
  const files = new FileSubscriptionSources();
  const id = localId("sub");
  const input = { schemaVersion: "FileSubscriptionRegistration@1", subscriptionId: id, title: "registered files",
    source: source(watched), workflowRef: "workflow:test/files@1" };
  try {
    const first = registerFileSubscription(root, input, runtime);
    assert.equal(first.definition.schemaVersion, "ContinuousSubscriptionDefinition@4");
    assert.equal(registerFileSubscription(root, input, runtime).id, first.id);
    assert.throws(() => registerFileSubscription(root, { ...input, command: "anything" }, runtime), /unknown field/);
    assert.throws(() => registerFileSubscription(root, { ...input, workflowRef: "workflow:missing/action@1" }, runtime), /not registered/);
    assert.throws(() => registerFileSubscription(root, { ...input, title: "different" }, runtime), /another definition/);
    await until(() => { files.runCycle(store, signal, new Date().toISOString()); return store.require(id).pendingOccurrenceKey !== undefined; });
    const executor = new ExternalWorkflowRuntime({ store: workflows, registry: loadOwnerExternalWorkflowRegistry(root, runtime), executor: new HostCallbackKernel() });
    executor.poll(signal);
    const result = await executor.settle();
    assert.equal(result.succeeded.length, 1);
    store.reconcileExternalWorkflows();
    const readback = inspectContinuousSubscriptionView(root, id, runtime)!;
    assert.equal(readback.externalWorkflowExecution?.receipt?.status, "succeeded");
    assert.equal(readback.externalWorkflowExecution?.receipt?.stdout, "file-sync-complete");
    assert.equal(readback.pendingOccurrenceKey, null);
    assert.ok(readback.checkpointOccurrenceKey);
    assert.equal(readback.probe, null);
    assert.equal((database.prepare("SELECT count(*) AS n FROM agent_runs").get() as { n:number }).n, 0);
  } finally { files.close(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});


test("continuous notifications respect the maximum merge delay and root replacement invalidates the listener", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rs-file-window-")));
  const watched = join(root, "watched");
  mkdirSync(watched);
  let notify: (() => void) | undefined;
  let parentNotify: (() => void) | undefined;
  let calls = 0;
  const watchPort = ((...args: unknown[]) => {
    const callback = args.at(-1) as (event: string, name: string) => void;
    if (calls++ === 0) parentNotify = () => callback("rename", "watched");
    else notify = () => callback("change", "a.md");
    return { on() {}, close() {} };
  }) as unknown as typeof watch;
  const listener = new FileEventListener(source(watched), watchPort);
  try {
    const startedAt = Date.now();
    for (let i = 0; i < 5; i++) { await delay(30); notify!(); }
    assert.equal(listener.due(startedAt + 200), undefined);
    assert.ok(listener.due(startedAt + 251));
    renameSync(watched, join(root, "old")); mkdirSync(watched); parentNotify!();
    assert.match(listener.error!, /replaced/);
    assert.equal(listener.due(Date.now() + 1000), undefined);
  } finally { listener.close(); rmSync(root, { recursive: true, force: true }); }
});
