import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { localId } from "../src/core/id.js";
import { runSubscriptionCommand } from "../src/entrypoints/cli/subscription.js";
import { ContinuousSubscriptionStore } from "../src/capabilities/subscription/continuous-store.js";
import { ExternalWorkflowStore } from "../src/infrastructure/proactive/external-workflow-store.js";
import { ExternalWorkflowRuntime } from "../src/application/proactive/external-workflow-runtime.js";
import { loadOwnerExternalWorkflowRegistry } from "../src/application/proactive/external-workflow-registry.js";
import { HostCallbackKernel } from "../src/infrastructure/callback/host-kernel.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { migrateLocalDatabase } from "../src/infrastructure/sqlite/schema/index.js";
import { writeSchemaVersion } from "../src/infrastructure/sqlite/schema/introspection.js";
import type { ExternalWorkflowRecoveryReceipt } from "../src/modules/proactive/recovery.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rs-file-recovery-")));
  const runtime = join(root, "runtime");
  const watched = join(root, "watched");
  mkdirSync(runtime); mkdirSync(watched);
  const databasePath = join(runtime, "runtime.db");
  initializeRuntimeSchema(databasePath);
  const executable = join(root, "workflow.sh");
  writeFileSync(executable, '#!/bin/sh\ncat > input.json\nprintf "attempt\\n" >> attempts.txt\nif [ -f ready ]; then printf "synced"; else printf "failed" >&2; exit 1; fi\n');
  chmodSync(executable, 0o700);
  const registry = { schemaVersion: "OwnerExternalWorkflowRegistry@1", workflows: [{
    schemaVersion: "OwnerExternalWorkflowRegistration@1", ref: "workflow:test/recovery@1", inputSchema: "Empty@1", fixedInput: {},
    command: { executable: pathToFileURL(executable).href, arguments: [], cwd: pathToFileURL(root).href,
      environment: { PATH: "/usr/bin:/bin" }, timeoutMilliseconds: 5000, maxOutputBytes: 1024 },
    authority: { filesystemRoots: [pathToFileURL(root).href], networkAccess: true },
    retry: { maxAttempts: 1, backoffMilliseconds: 1000 }
  }] };
  writeFileSync(join(runtime, "external-workflows.json"), JSON.stringify(registry), { mode: 0o600 });
  const database = new DatabaseSync(databasePath);
  const workflows = new ExternalWorkflowStore(database);
  const subscriptions = new ContinuousSubscriptionStore(database, { migrate: false, externalWorkflows: workflows });
  const id = localId("sub");
  function cli(command: string, argument: string): unknown {
    let output = "";
    assert.equal(runSubscriptionCommand(root, [command, argument], { write: (text) => { output += text; } }, runtime), 0);
    return JSON.parse(output) as unknown;
  }
  function jsonCommand(command: string, value: unknown): unknown {
    const path = join(root, `${command}.json`);
    writeFileSync(path, JSON.stringify(value));
    return cli(command, path);
  }
  jsonCommand("register-file", { schemaVersion: "FileSubscriptionRegistration@1", subscriptionId: id,
    title: "recovery fixture", workflowRef: "workflow:test/recovery@1",
    source: { kind: "file", root: watched, recursive: true, suffixes: [".md"], exclude: [],
      debounceMilliseconds: 100, maxDelayMilliseconds: 1000 } });
  const source = { kind: "continuous_subscription" as const, id, definitionRevision: "ContinuousSubscriptionDefinition@4:1" };
  const observe = (key: string) => subscriptions.recordObservation(id, { version: "fixture", occurrenceKey: key, facts: {}, terminal: null });
  const executor = () => new ExternalWorkflowRuntime({ store: workflows, registry: loadOwnerExternalWorkflowRegistry(root, runtime), executor: new HostCallbackKernel() });
  async function run() {
    const loop = executor();
    loop.poll(new AbortController().signal);
    const result = await loop.settle();
    subscriptions.reconcileExternalWorkflows();
    return result;
  }
  function request(action: string, requestId: string, occurrence = "pending") {
    const execution = workflows.execution(source, occurrence)!;
    return { schemaVersion: "FileSubscriptionRecovery@1", subscriptionId: id,
      expectedDefinitionRevision: source.definitionRevision, executionId: execution.executionId,
      expectedAttemptCount: execution.attemptCount, action, requestId, reason: "Owner checked fixture side-effect receipt",
      ...(action === "retry" ? { retrySafe: true } : {}) };
  }
  const recover = (value: unknown) => jsonCommand("recover-file", value) as ExternalWorkflowRecoveryReceipt;
  function unknown() {
    observe("pending");
    const claim = workflows.claimDue("fixture")[0]!;
    workflows.markEffectStarted(claim.execution.executionId, "fixture", claim.leaseToken);
    workflows.failAfterEffect(claim.execution.executionId, "fixture", claim.leaseToken, { outcome: "unknown", error: "crash after effect" });
    subscriptions.reconcileExternalWorkflows();
    return workflows.requireExecution(claim.execution.executionId);
  }
  return { root, runtime, database, workflows, subscriptions, id, source, executable, cli, observe, run, request, recover, unknown,
    close() { subscriptions.close(); database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("public file recovery retries one exact execution, preserves failed receipt, and is durable/idempotent", async () => {
  const f = fixture();
  try {
    f.observe("pending");
    await f.run();
    const before = f.workflows.execution(f.source, "pending")!;
    assert.equal(before.status, "failed");
    assert.equal(f.subscriptions.require(f.id).status, "blocked");
    const retry = f.request("retry", "retry-1");
    assert.throws(() => f.recover({ ...retry, retrySafe: false }), /retrySafe/);
    assert.throws(() => f.recover({ ...retry, expectedDefinitionRevision: "ContinuousSubscriptionDefinition@4:2" }), /revision/);
    assert.throws(() => f.recover({ ...retry, executionId: "wrong-execution" }), /execution conflict/);
    assert.throws(() => f.recover({ ...retry, expectedAttemptCount: 0 }), /attempt conflict/);
    const receipt = f.recover(retry);
    assert.equal(receipt.outcome, "queued");
    assert.deepEqual(receipt.previousReceipt, before.receipt);
    assert.deepEqual(f.recover(retry), receipt);
    assert.equal(f.subscriptions.require(f.id).checkpointOccurrenceKey, undefined);
    assert.equal(f.subscriptions.require(f.id).pendingOccurrenceKey, "pending");
    assert.equal(f.workflows.requireExecution(before.executionId).maxAttempts, 2);
    assert.deepEqual(f.workflows.requireExecution(before.executionId).target, before.target);
    assert.throws(() => f.recover({ ...retry, reason: "different payload" }), /requestId conflict/);
    writeFileSync(join(f.root, "ready"), "safe");
    assert.equal((await f.run()).succeeded.length, 1);
    const after = f.workflows.requireExecution(before.executionId);
    assert.equal(after.attemptCount, 2);
    assert.equal(after.receipt?.status, "succeeded");
    assert.equal(f.subscriptions.require(f.id).checkpointOccurrenceKey, "pending");
    assert.equal(f.subscriptions.require(f.id).pendingOccurrenceKey, undefined);
    // Duplicate decision after successful execution cannot enqueue another attempt.
    assert.deepEqual(f.recover(retry), receipt);
    assert.equal((await f.run()).succeeded.length, 0);
    assert.equal(readFileSync(join(f.root, "attempts.txt"), "utf8"), "attempt\nattempt\n");
    const stdin = JSON.parse(readFileSync(join(f.root, "input.json"), "utf8")) as {requestId:string; occurrenceKey:string};
    assert.equal(stdin.requestId, before.executionId);
    assert.equal(stdin.occurrenceKey, "pending");
    assert.deepEqual(f.cli("recoveries", f.id), [receipt]);
    assert.equal((f.database.prepare("SELECT count(*) AS n FROM external_workflow_executions").get() as {n:number}).n, 1);
    assert.equal((f.database.prepare("SELECT count(*) AS n FROM agent_runs").get() as {n:number}).n, 0);
  } finally { f.close(); }
});

test("unknown requires explicit result confirmation; success checkpoints without replay, failure still needs a safe retry", async () => {
  for (const outcome of ["succeeded", "failed"] as const) {
    const f = fixture();
    try {
      const original = f.unknown();
      assert.throws(() => f.recover(f.request("retry", "unsafe")), /resolve unknown first/);
      const request = f.request(`resolve-${outcome}`, "resolve-1");
      const receipt = f.recover(request);
      assert.equal(receipt.previousReceipt.status, "unknown");
      assert.equal(receipt.resolvedReceipt?.resolution, "manual");
      assert.deepEqual(f.workflows.requireExecution(original.executionId).unknownReceipt, original.receipt);
      assert.deepEqual(f.recover(request), receipt);
      if (outcome === "succeeded") {
        assert.equal(f.subscriptions.require(f.id).status, "active");
        assert.equal(f.subscriptions.require(f.id).checkpointOccurrenceKey, "pending");
        assert.equal((await f.run()).succeeded.length, 0);
      } else {
        assert.equal(f.subscriptions.require(f.id).status, "blocked");
        assert.equal(f.subscriptions.require(f.id).checkpointOccurrenceKey, undefined);
        const retryReceipt = f.recover(f.request("retry", "retry-after-resolution"));
        assert.deepEqual(retryReceipt.previousUnknownReceipt, original.receipt);
        writeFileSync(join(f.root, "ready"), "safe");
        await f.run();
        assert.equal(f.subscriptions.require(f.id).checkpointOccurrenceKey, "pending");
        assert.deepEqual(f.cli("recoveries", f.id), [retryReceipt, receipt]);
      }
    } finally { f.close(); }
  }
});

test("file recovery rejects cancelled sources and drift; transaction failure preserves pending and both receipts", async () => {
  const f = fixture();
  try {
    f.observe("pending"); await f.run();
    const before = f.subscriptions.require(f.id);
    const execution = f.workflows.execution(f.source, "pending")!;
    const request = f.request("retry", "atomic-retry");
    f.database.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON external_workflow_recovery_receipts BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
    assert.throws(() => f.recover(request), /fixture rollback/);
    assert.deepEqual(f.subscriptions.require(f.id), before);
    assert.deepEqual(f.workflows.requireExecution(execution.executionId), execution);
    assert.deepEqual(f.cli("recoveries", f.id), []);
    f.database.exec("DROP TRIGGER reject_recovery");
    writeFileSync(f.executable, "#!/bin/sh\nexit 0\n");
    assert.throws(() => f.recover(request), /changed after admission/);
    f.subscriptions.setStatus(f.id, "cancel");
    assert.throws(() => f.recover(request), /exact blocked/);
  } finally { f.close(); }
});

test("schema v73 workflow rows and unknown receipts survive v74 upgrade and recovery", () => {
  const f = fixture();
  try {
    const original = f.unknown();
    const before = f.database.prepare("SELECT * FROM external_workflow_executions").get()!;
    f.database.exec("DROP TABLE external_workflow_recovery_receipts; DROP TABLE external_workflow_executions");
    f.database.exec(readFileSync(resolve(import.meta.dirname, "../../test/fixtures/external-workflow-executions-v73.sql"), "utf8"));
    const columns = Object.keys(before);
    f.database.prepare(`INSERT INTO external_workflow_executions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map((key) => before[key]!));
    writeSchemaVersion(f.database, 73);
    migrateLocalDatabase(f.database);
    assert.deepEqual(f.database.prepare("SELECT * FROM external_workflow_executions").get(), before);
    const receipt = f.recover(f.request("resolve-failed", "after-migration"));
    assert.deepEqual(receipt.previousReceipt, original.receipt);
    f.recover(f.request("retry", "retry-after-migration"));
    assert.equal(f.workflows.requireExecution(original.executionId).maxAttempts, 2);
    assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.close(); }
});

test("terminal reconciliation excludes concurrent Owner writes until its source update commits", async () => {
  const f = fixture();
  const other = new DatabaseSync(join(f.runtime, "runtime.db"));
  other.exec("PRAGMA busy_timeout = 1");
  try {
    f.observe("pending"); await f.run();
    let checked = false;
    const reader = new ContinuousSubscriptionStore(f.database, { migrate: false, externalWorkflows: {
      enqueueInTransaction: (input) => f.workflows.enqueueInTransaction(input),
      execution: (source, occurrence) => {
        const result = f.workflows.execution(source, occurrence);
        assert.throws(() => other.prepare("UPDATE continuous_subscriptions SET status = 'active' WHERE subscription_id = ?").run(f.id), /locked/);
        checked = true;
        return result;
      }
    } });
    reader.reconcileExternalWorkflows();
    assert.equal(checked, true);
    f.recover(f.request("retry", "after-reconcile"));
    assert.equal(f.subscriptions.require(f.id).status, "active");
  } finally { other.close(); f.close(); }
});
