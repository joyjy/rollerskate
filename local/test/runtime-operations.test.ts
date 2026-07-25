import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { addLocalAgent } from "../src/application/agent/control.js";
import { controlRuntime } from "../src/application/runtime/control.js";
import {
  inspectRuntimeFailure,
  listRuntimeFailures
} from "../src/application/runtime/failure-query.js";
import { runtimeOperationsView } from "../src/application/runtime/query.js";
import { workloadStatus } from "../src/application/runtime/workload-query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";

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
    assert.equal(store.execution(running.executionId)?.status, "retry_wait");
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
    store.close();

    const failures = listRuntimeFailures(repo, runtimeDirectory);
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
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function writeLoopState(
  path: string,
  input: {
    readonly status: "running" | "stopped";
    readonly phase: "idle" | "in_cycle";
    readonly cycles: number;
    readonly updatedAt: string;
  }
): void {
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    status: input.status,
    startedAt: "2026-07-25T07:00:00.000Z",
    updatedAt: input.updatedAt,
    runtimeDirectory: join(path, ".."),
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
