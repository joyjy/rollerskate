import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  subscriptionRunBindingAdapter,
  subscriptionSourceBindingRegistrar,
  type RegisteredSubscriptionPlugin
} from "../src/application/subscription/source-binding.js";
import { applyRunDecisionInTransaction } from
  "../src/application/steward/decision.js";
import { startStewardRun } from "../src/application/steward/control.js";
import { ContinuousSubscriptionStore } from
  "../src/capabilities/subscription/continuous-store.js";
import { SubscriptionStore } from
  "../src/capabilities/subscription/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

const PLUGIN: RegisteredSubscriptionPlugin = {
  ref: "plugin:test-poll@1",
  path: "/registered/plugins/test-poll.mjs",
  id: "test-poll",
  artifactRevision: "test-poll@1",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  authorityDigest: `sha256:${"c".repeat(64)}`,
  workspaceRoot: "/registered/workspace",
  triggerKinds: ["until", "continuous"],
  allowedHttpOrigins: [],
  allowedExecutables: []
};

test("SubscriptionDefinition@4 activates one Run cycle for one terminal observation", () => {
  const fixture = setup();
  const started = startRun(fixture, "one-shot-run", "until");
  let context = openContext(fixture.paths.database);
  try {
    const bound = bind(context, started.run.runId, oneShotDecision(1));
    assert.equal(bound.status, "awaiting_source");
    const subscription = context.oneShot.boundForRun(bound.runId)!;
    assert.equal(subscription.definitionSchema, "SubscriptionDefinition@4");
    assert.equal(subscription.ownerAgentId, undefined);
    assert.equal(callbackCount(context, "subscription", subscription.subscriptionId), 0);

    const observed = context.oneShot.recordObservation(
      subscription.subscriptionId,
      {
        version: "observation-v1",
        facts: { ready: true },
        terminal: "success",
        summary: "ready"
      },
      "2026-08-26T08:01:00.000Z"
    );
    assert.equal(observed.cycleId === undefined, false);
    assert.equal(observed.admissionReceipt?.agentRunId, bound.runId);
    assert.equal(callbackCount(context, "subscription", subscription.subscriptionId), 0);
    const duplicate = context.oneShot.recordObservation(
      subscription.subscriptionId,
      {
        version: "observation-v1",
        facts: { ready: true },
        terminal: "success",
        summary: "ready"
      },
      "2026-08-26T08:01:01.000Z"
    );
    assert.equal(duplicate.cycleId, observed.cycleId);
    assert.equal(context.runs.cycles(bound.runId).length, 1);

    const active = context.runs.requireProjection(bound.runId);
    context.runtime.withImmediateTransaction(() => {
      context.runs.terminalizeInTransaction({
        runId: active.runId,
        expectedVersion: active.version,
        status: "succeeded",
        summary: "terminal observation accepted",
        scope: "cycle",
        updatedAt: "2026-08-26T08:01:10.000Z"
      });
    });
    closeContext(context);
    context = openContext(fixture.paths.database);
    assert.deepEqual(
      context.oneShot.reconcileBoundSources("2026-08-26T08:01:11.000Z"),
      [subscription.subscriptionId]
    );
    assert.equal(
      context.oneShot.require(subscription.subscriptionId).callbackPhaseStatus,
      "completed"
    );
    assert.equal(context.runs.requireProjection(bound.runId).status, "awaiting_source");
  } finally {
    closeContext(context);
    fixture.close();
  }
});

test("ContinuousSubscriptionDefinition@2 checkpoints only a succeeded Run cycle", () => {
  const fixture = setup();
  const started = startRun(fixture, "continuous-run", "continuous");
  let context = openContext(fixture.paths.database);
  try {
    const bound = bind(context, started.run.runId, continuousDecision(1));
    const subscription = context.continuous.boundForRun(bound.runId)!;
    assert.equal(
      subscription.definition.schemaVersion,
      "ContinuousSubscriptionDefinition@2"
    );
    assert.equal(callbackCount(
      context,
      "continuous_subscription",
      subscription.subscriptionId
    ), 0);

    const first = context.continuous.recordObservation(
      subscription.subscriptionId,
      observation("delta-1"),
      "2026-08-26T09:01:00.000Z"
    ).subscription;
    assert.equal(first.pendingCycleId === undefined, false);
    assert.equal(first.pendingAdmissionReceipt?.agentRunId, bound.runId);
    const duplicate = context.continuous.recordObservation(
      subscription.subscriptionId,
      observation("delta-1"),
      "2026-08-26T09:01:01.000Z"
    ).subscription;
    assert.equal(duplicate.pendingCycleId, first.pendingCycleId);
    assert.equal(context.runs.cycles(bound.runId).length, 1);

    finishCycle(context, bound.runId, "succeeded", "2026-08-26T09:01:10.000Z");
    closeContext(context);
    context = openContext(fixture.paths.database);
    assert.deepEqual(
      context.continuous.reconcileBoundOccurrences("2026-08-26T09:01:11.000Z"),
      [subscription.subscriptionId]
    );
    const checkpointed = context.continuous.require(subscription.subscriptionId);
    assert.equal(checkpointed.checkpointOccurrenceKey, "delta-1");
    assert.equal(checkpointed.pendingOccurrenceKey, undefined);

    const second = context.continuous.recordObservation(
      subscription.subscriptionId,
      observation("delta-2"),
      "2026-08-26T09:02:00.000Z"
    ).subscription;
    assert.equal(second.pendingOccurrenceKey, "delta-2");
    finishCycle(context, bound.runId, "failed", "2026-08-26T09:02:10.000Z");
    context.continuous.reconcileBoundOccurrences("2026-08-26T09:02:11.000Z");
    const failed = context.continuous.require(subscription.subscriptionId);
    assert.equal(failed.status, "blocked");
    assert.equal(failed.checkpointOccurrenceKey, "delta-1");
    assert.equal(failed.pendingOccurrenceKey, "delta-2");
    assert.equal(failed.latestError, "run-cycle-failed");
    assert.equal(callbackCount(
      context,
      "continuous_subscription",
      subscription.subscriptionId
    ), 0);
  } finally {
    closeContext(context);
    fixture.close();
  }
});

for (const outcome of ["needs_human"] as const) {
  test(`ContinuousSubscriptionDefinition@2 keeps checkpoint on ${outcome} cycle`, () => {
    const fixture = setup();
    const started = startRun(fixture, `continuous-${outcome}`, "continuous");
    const context = openContext(fixture.paths.database);
    try {
      const bound = bind(context, started.run.runId, continuousDecision(1));
      const subscription = context.continuous.boundForRun(bound.runId)!;
      context.continuous.recordObservation(
        subscription.subscriptionId,
        observation(`delta-${outcome}`),
        "2026-08-26T10:01:00.000Z"
      );
      finishCycle(context, bound.runId, outcome, "2026-08-26T10:01:10.000Z");
      context.continuous.reconcileBoundOccurrences("2026-08-26T10:01:11.000Z");
      const reconciled = context.continuous.require(subscription.subscriptionId);
      assert.equal(reconciled.status, "blocked");
      assert.equal(reconciled.checkpointOccurrenceKey, undefined);
      assert.equal(reconciled.pendingOccurrenceKey, `delta-${outcome}`);
      assert.equal(reconciled.latestError, `run-cycle-${outcome}`);
    } finally {
      closeContext(context);
      fixture.close();
    }
  });
}

test("ContinuousSubscriptionDefinition@2 blocks an unknown missing cycle receipt", () => {
  const fixture = setup();
  const started = startRun(fixture, "continuous-missing-cycle", "continuous");
  let context = openContext(fixture.paths.database);
  try {
    const bound = bind(context, started.run.runId, continuousDecision(1));
    const subscription = context.continuous.boundForRun(bound.runId)!;
    context.continuous.recordObservation(
      subscription.subscriptionId,
      observation("delta-missing-cycle"),
      "2026-08-26T11:01:00.000Z"
    );
    closeContext(context);
    context = openContext(fixture.paths.database, true);
    assert.deepEqual(
      context.continuous.reconcileBoundOccurrences("2026-08-26T11:01:11.000Z"),
      [subscription.subscriptionId]
    );
    const reconciled = context.continuous.require(subscription.subscriptionId);
    assert.equal(reconciled.status, "blocked");
    assert.equal(reconciled.checkpointOccurrenceKey, undefined);
    assert.equal(reconciled.pendingOccurrenceKey, "delta-missing-cycle");
    assert.equal(reconciled.latestError, "run-cycle-missing");
  } finally {
    closeContext(context);
    fixture.close();
  }
});

test("Subscription source binding rejects Owner registry drift after Run admission", () => {
  const fixture = setup();
  const started = startRun(fixture, "registry-drift-run", "until");
  const context = openContext(fixture.paths.database);
  try {
    const registrar = subscriptionSourceBindingRegistrar({
      oneShot: context.oneShot,
      continuous: context.continuous,
      resolvePlugin: () => ({
        ...PLUGIN,
        workspaceRoot: "/registered/changed-workspace",
        authorityDigest: `sha256:${"d".repeat(64)}`
      })
    });
    assert.throws(() => context.runtime.withImmediateTransaction(() =>
      applyRunDecisionInTransaction({
        runtime: context.runtime,
        runs: context.runs,
        run: context.runs.requireProjection(started.run.runId),
        decision: oneShotDecision(1),
        requestId: "bind:registry-drift",
        sourceKind: "handler",
        bindSource: registrar,
        at: "2026-08-26T08:00:01.000Z"
      })
    ), /registry changed after Run admission/);
    assert.equal(context.oneShot.boundForRun(started.run.runId), undefined);
  } finally {
    closeContext(context);
    fixture.close();
  }
});

function bind(
  context: Context,
  runId: string,
  decision: ReturnType<typeof oneShotDecision> | ReturnType<typeof continuousDecision>
) {
  const registrar = subscriptionSourceBindingRegistrar({
    oneShot: context.oneShot,
    continuous: context.continuous,
    resolvePlugin: (ref) => ref === PLUGIN.ref ? PLUGIN : undefined
  });
  return context.runtime.withImmediateTransaction(() =>
    applyRunDecisionInTransaction({
      runtime: context.runtime,
      runs: context.runs,
      run: context.runs.requireProjection(runId),
      decision,
      requestId: `bind:${runId}`,
      sourceKind: "handler",
      bindSource: registrar,
      at: "2026-08-26T08:00:01.000Z"
    }).run
  );
}

function oneShotDecision(expectedRunVersion: number) {
  return decision(expectedRunVersion, "subscription", "subscription.until@1", {
    title: "Wait for terminal observation",
    pluginRef: PLUGIN.ref,
    pluginConfig: { expected: "ready" },
    intervalMilliseconds: 1_000,
    maxWaitMilliseconds: 60_000,
    maxAttempts: 10,
    cancellationPolicy: "pause_source"
  });
}

function continuousDecision(expectedRunVersion: number) {
  return decision(
    expectedRunVersion,
    "continuous_subscription",
    "subscription.continuous@1",
    {
      title: "Watch observation deltas",
      pluginRef: PLUGIN.ref,
      pluginConfig: { cursor: "stable" },
      intervalMilliseconds: 1_000,
      cancellationPolicy: "pause_source"
    }
  );
}

function decision(
  expectedRunVersion: number,
  sourceKind: "subscription" | "continuous_subscription",
  templateId: string,
  parameters: Readonly<Record<string, unknown>>
) {
  return {
    schemaVersion: "RunDecision@3",
    action: "await_source",
    expectedRunVersion,
    rationale: "Wait for the registered Subscription source",
    checkedAcceptance: [],
    state: {
      schemaVersion: "OrchestratorState@1",
      goal: "Process observations",
      tasks: [],
      acceptedEvidence: [],
      unresolvedQuestions: []
    },
    awaitSource: { sourceKind, templateId, parameters }
  } as const;
}

function observation(occurrenceKey: string) {
  return {
    version: `observation:${occurrenceKey}`,
    occurrenceKey,
    facts: { occurrenceKey },
    terminal: null
  } as const;
}

function finishCycle(
  context: Context,
  runId: string,
  status: "succeeded" | "failed" | "needs_human",
  at: string
): void {
  const active = context.runs.requireProjection(runId);
  context.runtime.withImmediateTransaction(() => {
    context.runs.terminalizeInTransaction({
      runId,
      expectedVersion: active.version,
      status,
      summary: `cycle ${status}`,
      scope: "cycle",
      updatedAt: at
    });
  });
}

interface Context {
  readonly database: ReturnType<typeof openRuntimeDatabase>;
  readonly runtime: RuntimeStore;
  readonly runs: AgentRunStore;
  readonly oneShot: SubscriptionStore;
  readonly continuous: ContinuousSubscriptionStore;
}

function openContext(databasePath: string, missingCycles = false): Context {
  const database = openRuntimeDatabase(databasePath);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  const adapter = subscriptionRunBindingAdapter({ runtime, runs });
  const runBinding = missingCycles
    ? { ...adapter, cycleState: () => undefined }
    : adapter;
  return {
    database,
    runtime,
    runs,
    oneShot: new SubscriptionStore(database, { runBinding }),
    continuous: new ContinuousSubscriptionStore(database, { runBinding })
  };
}

function closeContext(context: Context): void {
  context.oneShot.close();
  context.continuous.close();
  context.runs.close();
  context.runtime.close();
  context.database.close();
}

function callbackCount(
  context: Context,
  ownerKind: "subscription" | "continuous_subscription",
  ownerId: string
): number {
  return (context.database.prepare(`
    SELECT COUNT(*) AS count FROM proactive_callback_occurrences
    WHERE owner_kind = ? AND owner_id = ?
  `).get(ownerKind, ownerId) as { count: number }).count;
}

function startRun(
  fixture: ReturnType<typeof setup>,
  requestId: string,
  triggerKind: "until" | "continuous"
) {
  return startStewardRun(fixture.repo, {
    requestId,
    steward: "codex",
    objective: "Process each admitted Subscription occurrence",
    maxSteps: 20,
    maxDepth: 0,
    participantAgentIds: fixture.agentIds,
    orchestration: {
      mode: "steward",
      admission: {
        digest: `sha256:${"b".repeat(64)}`,
        authority: {
          schemaVersion: "RunAuthorityEnvelope@1",
          participantAgentIds: fixture.agentIds,
          trigger: {
            allowedKinds: [triggerKind],
            minimumIntervalMilliseconds: 1_000,
            maximumIntervalMilliseconds: 86_400_000,
            pluginRefs: [PLUGIN.ref],
            pluginPolicyDigests: { [PLUGIN.ref]: PLUGIN.authorityDigest },
            allowedHttpOrigins: [],
            allowedExecutables: []
          },
          destinationIds: [],
          maxSteps: 20,
          maxDepth: 0
        }
      }
    }
  }, fixture.runtimeDirectory, "2026-08-26T08:00:00.000Z");
}

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-subscription-binding-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-subscription-binding-runtime-")
  );
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-08-26T07:59:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  const codex = foundation.addAgent("codex", "codex", "2026-08-26T07:59:00.000Z");
  const worker = foundation.addAgent("worker", "codex", "2026-08-26T07:59:00.000Z");
  foundation.close();
  return {
    repo,
    runtimeDirectory,
    paths,
    agentIds: [codex.principalId, worker.principalId].sort(),
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}
