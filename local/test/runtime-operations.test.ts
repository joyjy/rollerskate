import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { addLocalAgent } from "../src/application/agent/control.js";
import {
  subscriptionSourceBindingRegistrar
} from "../src/application/subscription/source-binding.js";
import { resolveRegisteredSubscriptionPlugin } from
  "../src/application/subscription/plugin-registry.js";
import { applyRunDecisionInTransaction } from
  "../src/application/steward/decision.js";
import { controlRuntime } from "../src/application/runtime/control.js";
import {
  inspectRuntimeFailure,
  listRuntimeFailures
} from "../src/application/runtime/failure-query.js";
import { runtimeOperationsView } from "../src/application/runtime/query.js";
import { workloadStatus } from "../src/application/runtime/workload-query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { ContinuousSubscriptionStore } from
  "../src/capabilities/subscription/continuous-store.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { runtimeArtifactRevision } from "../src/infrastructure/runtime/revision.js";
import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from
  "../src/infrastructure/sqlite/database.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("Runtime workload projects canonical active work without counting terminal history", () => {
  assert.deepEqual(workloadStatus({
    readyExecutions: 2,
    runningExecutions: 1,
    retryingExecutions: 3,
    pendingDeliveries: 4,
    deliveringDeliveries: 5,
    retryingDeliveries: 6,
    pendingScheduledRuns: 7,
    runningScheduledRuns: 8
  }, "2026-07-25T00:00:00.000Z"), {
    state: "running",
    ready: 13,
    running: 14,
    retrying: 9,
    total: 36,
    asOf: "2026-07-25T00:00:00.000Z"
  });
  assert.equal(workloadStatus({
    readyExecutions: 0,
    runningExecutions: 0,
    retryingExecutions: 1,
    pendingDeliveries: 0,
    deliveringDeliveries: 0,
    retryingDeliveries: 0,
    pendingScheduledRuns: 0,
    runningScheduledRuns: 0
  }, "2026-07-25T00:00:00.000Z").state, "retrying");
});

test("Runtime artifact revision changes with executable JavaScript", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-runtime-revision-"));
  try {
    const localDist = join(repo, "local", "dist", "src");
    const protocolDist = join(repo, "packages", "protocol", "dist", "src");
    mkdirSync(localDist, { recursive: true });
    mkdirSync(protocolDist, { recursive: true });
    writeFileSync(join(localDist, "main.js"), "export const revision = 1;\n");
    writeFileSync(join(protocolDist, "index.js"), "export const protocol = 1;\n");
    const first = runtimeArtifactRevision(repo);
    writeFileSync(join(localDist, "main.js.map"), "ignored source map");
    assert.equal(runtimeArtifactRevision(repo), first);
    writeFileSync(join(localDist, "main.js"), "export const revision = 2;\n");
    assert.notEqual(runtimeArtifactRevision(repo), first);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Runtime status and CLI/Console controls share structured availability", () => {
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-runtime-operations-state-")
  );
  const at = "2026-07-25T08:00:00.000Z";
  try {
    const agent = addLocalAgent(projectRoot, "operator", "codex", { runtimeDirectory });
    const paths = runtimePaths(projectRoot, runtimeDirectory);
    const store = new RuntimeStore(paths.database);
    const queued = store.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "runtime-operations-control" },
      agentId: agent.principalId,
      prompt: "keep this work in flight",
      maxAttempts: 3,
      createdAt: at
    });
    const running = store.claimDueExecutions(1, at)[0]!;
    assert.equal(running.executionId, queued.execution.executionId);

    writeLoopState(paths.loopState, {
      status: "running",
      phase: "in_cycle",
      cycles: 12,
      updatedAt: new Date().toISOString()
    });
    const active = runtimeOperationsView(projectRoot, runtimeDirectory, "localhost:4300");
    assert.equal(active.status, "running");
    assert.equal(active.runtimeRevision.matchesExpected, true);
    assert.equal(active.runtimeRevision.running, active.runtimeRevision.expected);
    assert.equal(active.loop.phase, "in_cycle");
    assert.deepEqual(active.controls, { pause: true, resume: false, recover: false });
    assert.equal(active.workload.running, 1);

    assert.equal(controlRuntime(projectRoot, "pause", runtimeDirectory).kind, "pause");
    const paused = runtimeOperationsView(projectRoot, runtimeDirectory, "localhost:4300");
    assert.equal(paused.status, "paused");
    assert.deepEqual(paused.controls, { pause: false, resume: true, recover: false });
    assert.equal(controlRuntime(projectRoot, "resume", runtimeDirectory).kind, "resume");

    writeLoopState(paths.loopState, {
      status: "stopped",
      phase: "idle",
      cycles: 12,
      updatedAt: new Date().toISOString()
    });
    const stopped = runtimeOperationsView(projectRoot, runtimeDirectory, "localhost:4300");
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(stopped.controls, { pause: false, resume: false, recover: true });
    assert.equal(controlRuntime(projectRoot, "recover", runtimeDirectory).kind, "recover");
    assert.equal(store.execution(running.executionId)?.status, "failed");
    assert.equal(
      store.execution(running.executionId)?.lastError,
      "runtime_interrupted_unknown"
    );
    assert.equal(store.audit(queued.event.eventId)?.resultEvent?.outcome, "failed");
    assert.equal(
      runtimeOperationsView(projectRoot, runtimeDirectory, "localhost:4300").controls.recover,
      false
    );
    store.close();
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Runtime failures and Event/Workload CLI share the application projections", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-runtime-failure-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-runtime-failure-state-"));
  const at = "2026-07-25T09:00:00.000Z";
  try {
    const agent = addLocalAgent(repo, "operator", "codex", { runtimeDirectory });
    const store = new RuntimeStore(runtimePaths(repo, runtimeDirectory).database);
    const receipt = store.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "runtime-operations-failure" },
      agentId: agent.principalId,
      prompt: "fail once",
      maxAttempts: 1,
      createdAt: at
    });
    const running = store.claimDueExecutions(1, at)[0]!;
    store.failExecution(running.executionId, "provider failed", at);
    const delivery = store.enqueueHostDelivery({
      originId: "runtime-operations-delivery",
      destinationId: "dst_019f0000-0000-7000-8000-000000000123",
      kind: "server-topic",
      address: { topicId: "topic-a", agentId: "agent-a" },
      payload: { body: "deliver once" },
      maxAttempts: 1,
      at
    });
    assert.equal(store.claimDueDeliveries(1, at)[0]?.deliveryId, delivery.deliveryId);
    store.deliveryFailed(delivery.deliveryId, "server offline", at);
    store.close();

    const failures = listRuntimeFailures(repo, runtimeDirectory);
    const deliveryFailure = failures.find((candidate) =>
      candidate.objectRef === delivery.deliveryId);
    assert.equal(deliveryFailure?.action.kind, "recover");
    assert.equal(
      deliveryFailure?.action.cliHint,
      `scripts/rs failure retry failure:delivery:${delivery.deliveryId}`
    );
    const failure = failures.find((candidate) =>
      candidate.objectRef === running.executionId);
    assert.equal(failure?.owner, "event");
    assert.equal(failure?.eventId, receipt.event.eventId);
    assert.match(failure?.action.cliHint ?? "", /event trace/);
    assert.equal(
      failure?.action.consoleRoute,
      `/console/events?eventId=${receipt.event.eventId}`
    );
    const detail = inspectRuntimeFailure(repo, failure!.failureRef, runtimeDirectory);
    assert.deepEqual(detail.evidence.map(({ kind, ref }) => [kind, ref]), [
      ["object", running.executionId],
      ["event", receipt.event.eventId]
    ]);

    let workloadOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtimeDirectory, "workload", "status"
    ], {}, { write(text) { workloadOutput += text; } }), 0);
    assert.match(workloadOutput, /Loop workload: queued/);

    let eventOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtimeDirectory, "event", "trace", receipt.event.eventId
    ], {}, { write(text) { eventOutput += text; } }), 0);
    assert.equal((JSON.parse(eventOutput) as {
      event: { eventId: string };
    }).event.eventId, receipt.event.eventId);

    let failureOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtimeDirectory, "failure", "inspect", failure!.failureRef
    ], {}, { write(text) { failureOutput += text; } }), 0);
    assert.equal((JSON.parse(failureOutput) as {
      failureRef: string;
    }).failureRef, failure!.failureRef);

    let retryOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtimeDirectory,
      "failure", "retry", deliveryFailure!.failureRef
    ], {}, { write(text) { retryOutput += text; } }), 0);
    const retry = JSON.parse(retryOutput) as {
      schemaVersion: string;
      failureRef: string;
      deliveryId: string;
      previousStatus: string;
      status: string;
      attemptCount: number;
      maxAttempts: number;
      nextAttemptAt: string;
    };
    assert.deepEqual(retry, {
      schemaVersion: "DeliveryRetryReceipt@1",
      failureRef: deliveryFailure!.failureRef,
      deliveryId: delivery.deliveryId,
      previousStatus: "failed",
      status: "retry_wait",
      attemptCount: 1,
      maxAttempts: 2,
      nextAttemptAt: retry.nextAttemptAt
    });
    let repeatedOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtimeDirectory,
      "failure", "retry", deliveryFailure!.failureRef
    ], {}, { write(text) { repeatedOutput += text; } }), 0);
    assert.deepEqual(JSON.parse(repeatedOutput), {
      ...retry,
      previousStatus: "retry_wait"
    });
    const retryStore = new RuntimeStore(runtimePaths(repo, runtimeDirectory).database);
    const claimedDelivery = retryStore.claimDueDeliveries(1, retry.nextAttemptAt)[0]!;
    assert.equal(claimedDelivery.deliveryId, delivery.deliveryId);
    assert.equal(claimedDelivery.attemptCount, 2);
    retryStore.deliverySucceeded(delivery.deliveryId, "server-event-a", retry.nextAttemptAt);
    assert.equal(retryStore.delivery(delivery.deliveryId)?.status, "delivered");
    retryStore.close();
    let deliveredOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtimeDirectory,
      "failure", "retry", deliveryFailure!.failureRef
    ], {}, { write(text) { deliveredOutput += text; } }), 0);
    assert.deepEqual(JSON.parse(deliveredOutput), {
      ...retry,
      previousStatus: "delivered",
      status: "delivered",
      attemptCount: 2
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Run and Event CLI queries do not write to a read-only Runtime", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-readonly-query-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-readonly-query-state-")
  );
  const intentPath = join(repo, "run-intent.json");
  const pluginPath = join(repo, "readonly-query.mjs");
  const paths = runtimePaths(repo, runtimeDirectory);
  try {
    addLocalAgent(repo, "codex", "codex", { runtimeDirectory });
    addLocalAgent(repo, "kimi", "kimi-code", { runtimeDirectory });
    writeFileSync(pluginPath, [
      "export default {",
      "kind: 'subscription.probe', id: 'readonly-query', schemaVersion: 1,",
      "plan() { return { kind: 'command', executable: '/usr/bin/true', args: [] }; },",
      "evaluate() { return { version: '1', facts: {}, terminal: null }; }",
      "};"
    ].join("\n"));
    writeFileSync(paths.subscriptionPlugins, JSON.stringify({
      schemaVersion: "SubscriptionPluginRegistry@1",
      plugins: [{
        ref: "plugin:readonly-query@1",
        pluginPath: "project:readonly-query.mjs",
        pluginId: "readonly-query",
        workspaceRef: "project:self",
        triggerKinds: ["continuous"],
        allowedHttpOrigins: [],
        allowedExecutables: []
      }]
    }));
    writeFileSync(intentPath, `${JSON.stringify({
      schemaVersion: "RunIntent@1",
      requestId: "readonly-query-regression",
      objective: "Prove Run queries remain read-only",
      acceptance: ["Run remains inspectable"],
      contextRefs: [],
      triggerIntent: "continuous",
      requestedParticipantRefs: ["agent:kimi"],
      terminalEvidence: ["CLI JSON readback"]
    }, null, 2)}\n`);

    let startOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtimeDirectory, "run", "start", intentPath
    ], {}, { write(text) { startOutput += text; } }), 0);
    const started = JSON.parse(startOutput) as {
      readonly run: { readonly runId: string; readonly version: number };
      readonly rootEventId: string;
    };

    const writableDatabase = openRuntimeDatabase(paths.database);
    const runtime = new RuntimeStore(writableDatabase);
    const runs = new AgentRunStore(writableDatabase);
    const oneShot = new SubscriptionStore(writableDatabase);
    const continuous = new ContinuousSubscriptionStore(writableDatabase);
    const plugin = resolveRegisteredSubscriptionPlugin(
      repo,
      "plugin:readonly-query@1",
      runtimeDirectory
    );
    assert.notEqual(plugin, undefined);
    try {
      const bindSource = subscriptionSourceBindingRegistrar({
        oneShot,
        continuous,
        resolvePlugin: (ref) => ref === plugin!.ref ? plugin : undefined
      });
      runtime.withImmediateTransaction(() => applyRunDecisionInTransaction({
        runtime,
        runs,
        run: runs.requireProjection(started.run.runId),
        decision: {
          schemaVersion: "RunDecision@3",
          action: "await_source",
          expectedRunVersion: started.run.version,
          rationale: "Exercise the read-only source detail path",
          checkedAcceptance: [],
          state: {
            schemaVersion: "OrchestratorState@1",
            goal: "Keep the query fixture inspectable",
            tasks: [],
            acceptedEvidence: [],
            unresolvedQuestions: []
          },
          awaitSource: {
            sourceKind: "continuous_subscription",
            templateId: "subscription.continuous@1",
            parameters: {
              title: "Read-only query fixture",
              pluginRef: plugin!.ref,
              pluginConfig: { cursor: "stable" },
              intervalMilliseconds: 1_000,
              cancellationPolicy: "pause_source"
            }
          }
        },
        requestId: "readonly-query-source-binding",
        sourceKind: "handler",
        bindSource,
        at: "2026-08-27T12:00:00.000Z"
      }));
    } finally {
      continuous.close();
      oneShot.close();
      runs.close();
      runtime.close();
    }

    try {
      writableDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      writableDatabase.exec("PRAGMA journal_mode = DELETE");
    } finally {
      writableDatabase.close();
    }
    chmodSync(paths.database, 0o444);
    chmodSync(runtimeDirectory, 0o555);
    const before = readOnlyRuntimeSnapshot(runtimeDirectory, paths.database);

    for (const command of [
      ["run", "list"],
      ["run", "inspect", started.run.runId],
      ["run", "trace", started.run.runId],
      ["event", "list"],
      ["event", "trace", started.rootEventId]
    ]) {
      let output = "";
      assert.equal(await runLocalApp(repo, [
        "--runtime", runtimeDirectory, ...command
      ], {}, { write(text) { output += text; } }), 0);
      assert.doesNotThrow(() => JSON.parse(output));
    }

    assert.deepEqual(
      readOnlyRuntimeSnapshot(runtimeDirectory, paths.database),
      before
    );
  } finally {
    chmodSync(runtimeDirectory, 0o700);
    try {
      chmodSync(paths.database, 0o600);
    } catch {
      // The setup may fail before the database is created.
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function readOnlyRuntimeSnapshot(runtimeDirectory: string, databasePath: string) {
  const database = openRuntimeDatabaseReadOnly(databasePath);
  try {
    const schema = database.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'"
    ).get() as { readonly value: string } | undefined;
    const stat = statSync(databasePath);
    return {
      hash: createHash("sha256").update(readFileSync(databasePath)).digest("hex"),
      size: stat.size,
      mode: stat.mode & 0o777,
      modifiedAt: stat.mtimeMs,
      schemaVersion: schema?.value,
      files: readdirSync(runtimeDirectory).sort()
    };
  } finally {
    database.close();
  }
}

function writeLoopState(
  path: string,
  input: {
    readonly status: "running" | "stopped";
    readonly phase: "idle" | "in_cycle";
    readonly cycles: number;
    readonly updatedAt: string;
    readonly runtimeRevision?: string;
  }
): void {
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    status: input.status,
    startedAt: "2026-07-25T07:00:00.000Z",
    updatedAt: input.updatedAt,
    runtimeDirectory: join(path, ".."),
    runtimeRevision: input.runtimeRevision ?? runtimeArtifactRevision(projectRoot),
    agentNames: ["operator"],
    routeIds: ["agent.request"],
    cycles: input.cycles,
    paused: false,
    phase: input.phase,
    ...(input.phase === "in_cycle"
      ? {
          cycleStartedAt: input.updatedAt,
          currentPhaseSummary: "runtime"
        }
      : {})
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
