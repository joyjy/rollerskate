import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyRunDecisionInTransaction } from
  "../src/application/steward/decision.js";
import { startStewardRunFromIntent } from
  "../src/application/steward/intent-control.js";
import { activateRunSourceOccurrenceInTransaction } from
  "../src/application/steward/source-control.js";
import { cancelStewardRun } from "../src/application/steward/control.js";
import { StewardModule } from "../src/application/steward/module.js";
import {
  AgentHandler,
  ResultHandler,
  type RuntimeAgentAdapter
} from "../src/core/runtime/handlers.js";
import type { RuntimeExecution } from "../src/core/runtime/model.js";
import { runtimeId } from "../src/core/runtime/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import type { AgentRunProjection } from
  "../src/modules/steward/state-machine.js";
import type { RunSourceBinding } from
  "../src/modules/steward/source-contract.js";
import { runAuthorityDigest } from
  "../src/modules/steward/admission-contract.js";

test("RunDecision@3 await_source and source cycle execute through the Runtime loop", async () => {
  const fixture = setup();
  const started = startStewardRunFromIntent(fixture.repo, intent("runtime-loop-run"),
    fixture.runtimeDirectory, "2026-08-26T01:00:00.000Z");
  const outputs = [
    JSON.stringify(awaitScheduleDecision(1)),
    JSON.stringify(finishDecision(3, "cycle"))
  ];
  const prompts: string[] = [];
  let invocation = 0;
  const database = openRuntimeDatabase(fixture.paths.database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  const manifest = new StewardModule({
    runs,
    runtime,
    bindSource: ({ run }) => scheduleBinding(run)
  }).manifest();
  const adapter: RuntimeAgentAdapter = {
    adapterId: "steward-source-scripted",
    workspace: fixture.paths.workspace,
    async invoke(input) {
      prompts.push(input.event.prompt);
      const body = outputs.shift();
      if (body === undefined) throw new Error("scripted RunDecision@3 output exhausted");
      invocation += 1;
      return {
        providerSessionId: `codex-source-session-${invocation}`,
        outcome: { kind: "message", body },
        invocation: {
          schemaVersion: "AgentInvocationDiagnostics@1",
          effectivePrompt: input.event.prompt,
          startedAt: "2026-08-26T01:00:00.000Z",
          completedAt: "2026-08-26T01:00:01.000Z",
          durationMilliseconds: 1_000
        }
      };
    }
  };
  const agents = new AgentHandler({
    store: runtime,
    adapters: new Map([[started.run.stewardAgentId, adapter]]),
    executionGuards: manifest.executionGuards
  });
  const results = new ResultHandler(runtime, manifest.resultContinuations);
  try {
    await agents.handle(claim(runtime, "agent", "2026-08-26T01:00:01.000Z"),
      "2026-08-26T01:00:01.000Z");
    results.handle(claim(runtime, "result", "2026-08-26T01:00:02.000Z"),
      "2026-08-26T01:00:02.000Z");
    const bound = runs.requireProjection(started.run.runId);
    assert.equal(bound.status, "awaiting_source");
    assert.equal(runs.decisions(bound.runId)[0]?.decision.schemaVersion, "RunDecision@3");

    const activated = runtime.withImmediateTransaction(() =>
      activateRunSourceOccurrenceInTransaction({
        runtime,
        runs,
        runId: bound.runId,
        envelope: occurrenceEnvelope(
          bound,
          "runtime-occurrence",
          "runtime-revision",
          "2026-08-26T01:01:00.000Z"
        ),
        at: "2026-08-26T01:01:00.000Z"
      }));
    assert.equal(activated.run.version, 3);
    await agents.handle(claim(runtime, "agent", "2026-08-26T01:01:01.000Z"),
      "2026-08-26T01:01:01.000Z");
    results.handle(claim(runtime, "result", "2026-08-26T01:01:02.000Z"),
      "2026-08-26T01:01:02.000Z");
    const afterCycle = runs.requireProjection(bound.runId);
    const resultReceipts = database.prepare(`
      SELECT receipt_json FROM executions
      WHERE handler = 'result' AND receipt_json IS NOT NULL
      ORDER BY created_at DESC
    `).all();
    assert.equal(afterCycle.status, "awaiting_source", JSON.stringify(resultReceipts));
    assert.equal(runs.cycle(activated.cycle.cycleId)?.status, "succeeded");
    assert.match(prompts[0]!, /RunDecision@3/u);
    assert.match(prompts[0]!, /For await_source use:/u);
    assert.match(prompts[1]!, /TriggerOccurrenceEnvelope@1/u);
    assert.match(prompts[1]!, /await_source is invalid now/u);
    assert.doesNotMatch(prompts[1]!, /For await_source use:/u);
  } finally {
    runs.close();
    runtime.close();
    database.close();
    fixture.close();
  }
});

test("RunDecision@3 binds one source and finish scope separates cycle from Run", () => {
  const fixture = setup();
  const database = openRuntimeDatabase(fixture.paths.database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  try {
    const started = startStewardRunFromIntent(fixture.repo, intent("source-run"),
      fixture.runtimeDirectory, "2026-08-26T02:00:00.000Z");
    assert.equal(started.run.orchestratorBinding?.schemaVersion, "OrchestratorBinding@3");
    const rootEvent = runtime.event(started.rootEventId);
    assert.equal(rootEvent?.type, "agent.request");
    assert.equal(rootEvent?.type === "agent.request"
      ? rootEvent.runContext?.resultContractId
      : undefined, "run-decision@3");
    const bound = runtime.withImmediateTransaction(() =>
      applyRunDecisionInTransaction({
        runtime,
        runs,
        run: runs.requireProjection(started.run.runId),
        decision: awaitScheduleDecision(1),
        requestId: "decision-bind-source",
        sourceKind: "handler",
        bindSource: ({ run }) => scheduleBinding(run),
        at: "2026-08-26T02:00:01.000Z"
      }));
    assert.equal(bound.run.status, "awaiting_source");
    assert.equal(bound.run.seriesKey, `series:${started.run.runId}`);
    assert.equal(bound.run.sourceBinding?.source.id, "sch_fixture");
    assert.equal(bound.decision.schemaVersion, "AgentRunDecisionReceipt@2");
    assert.equal(bound.decision.action, "await_source");
    const firstEnvelope = occurrenceEnvelope(bound.run, "occurrence-1", "revision-1",
      "2026-08-26T02:01:00.000Z");
    const first = runtime.withImmediateTransaction(() =>
      activateRunSourceOccurrenceInTransaction({
        runtime,
        runs,
        runId: started.run.runId,
        envelope: firstEnvelope,
        at: "2026-08-26T02:01:00.000Z"
      }));
    assert.equal(first.status, "accepted");
    assert.equal(first.run.status, "awaiting_orchestrator");
    assert.equal(first.run.activeExecutionId, undefined);
    assert.equal(first.cycle.sourceEnvelope?.occurrenceKey, "occurrence-1");
    assert.throws(() => runtime.withImmediateTransaction(() =>
      applyRunDecisionInTransaction({
        runtime,
        runs,
        run: runs.requireProjection(started.run.runId),
        decision: finishDecision(first.run.version - 1, "cycle"),
        requestId: "stale-cycle-decision",
        sourceKind: "handler",
        at: "2026-08-26T02:01:00.500Z"
      })), /expected version 2 but current is 3/u);
    const occurrenceEvent = runtime.event(first.orchestratorEventId);
    assert.equal(occurrenceEvent?.type, "agent.request");
    assert.equal(occurrenceEvent?.type === "agent.request"
      ? occurrenceEvent.runContext?.resultContractId
      : undefined, "run-decision@3");
    const replay = runtime.withImmediateTransaction(() =>
      activateRunSourceOccurrenceInTransaction({
        runtime,
        runs,
        runId: started.run.runId,
        envelope: firstEnvelope,
        at: "2026-08-26T02:01:01.000Z"
      }));
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.cycle.cycleId, first.cycle.cycleId);
    assert.equal(replay.orchestratorEventId, first.orchestratorEventId);

    const cycleFinished = runtime.withImmediateTransaction(() =>
      applyRunDecisionInTransaction({
        runtime,
        runs,
        run: runs.requireProjection(started.run.runId),
        decision: finishDecision(first.run.version, "cycle"),
        requestId: "finish-first-cycle",
        sourceKind: "handler",
        at: "2026-08-26T02:02:00.000Z"
      }));
    assert.equal(cycleFinished.run.status, "awaiting_source");
    assert.equal(cycleFinished.run.activeCycleId, undefined);
    assert.equal(runs.cycle(first.cycle.cycleId)?.status, "succeeded");

    const second = runtime.withImmediateTransaction(() =>
      activateRunSourceOccurrenceInTransaction({
        runtime,
        runs,
        runId: started.run.runId,
        envelope: occurrenceEnvelope(
          cycleFinished.run,
          "occurrence-2",
          "revision-2",
          "2026-08-26T02:03:00.000Z"
        ),
        at: "2026-08-26T02:03:00.000Z"
      }));
    const runFinished = runtime.withImmediateTransaction(() =>
      applyRunDecisionInTransaction({
        runtime,
        runs,
        run: runs.requireProjection(started.run.runId),
        decision: finishDecision(second.run.version, "run"),
        requestId: "finish-whole-run",
        sourceKind: "handler",
        at: "2026-08-26T02:04:00.000Z"
      }));
    assert.equal(runFinished.run.status, "succeeded");
    assert.equal(runFinished.run.sourceBinding?.source.id, "sch_fixture");
    assert.equal(runs.cycle(second.cycle.cycleId)?.status, "succeeded");
  } finally {
    runs.close();
    runtime.close();
    database.close();
    fixture.close();
  }
});

test("source occurrence enforces authority, roster, restart recovery, and cancel", () => {
  const fixture = setup();
  let runId: string;
  let cycleId: string;
  {
    const database = openRuntimeDatabase(fixture.paths.database);
    const runtime = new RuntimeStore(database);
    const runs = new AgentRunStore(database);
    try {
      const started = startStewardRunFromIntent(fixture.repo, intent("restart-run"),
        fixture.runtimeDirectory, "2026-08-26T03:00:00.000Z");
      runId = started.run.runId;
      const bound = runtime.withImmediateTransaction(() =>
        applyRunDecisionInTransaction({
          runtime,
          runs,
          run: runs.requireProjection(runId),
          decision: awaitScheduleDecision(1),
          requestId: "bind-before-restart",
          sourceKind: "handler",
          bindSource: ({ run }) => scheduleBinding(run),
          at: "2026-08-26T03:00:01.000Z"
        }));
      const invalidEnvelope = {
        ...occurrenceEnvelope(
          bound.run,
          "bad-authority",
          "bad-revision",
          "2026-08-26T03:01:00.000Z"
        ),
        binding: {
          ...occurrenceEnvelope(
            bound.run,
            "bad-authority",
            "bad-revision",
            "2026-08-26T03:01:00.000Z"
          ).binding,
          authorityDigest: `sha256:${"0".repeat(64)}`
        }
      };
      assert.throws(() => runtime.withImmediateTransaction(() =>
        activateRunSourceOccurrenceInTransaction({
          runtime,
          runs,
          runId,
          envelope: invalidEnvelope,
          at: "2026-08-26T03:01:00.000Z"
        })), /does not match the Run source binding/u);
      const activated = runtime.withImmediateTransaction(() =>
        activateRunSourceOccurrenceInTransaction({
          runtime,
          runs,
          runId,
          envelope: occurrenceEnvelope(
            bound.run,
            "restart-occurrence",
            "restart-revision",
            "2026-08-26T03:02:00.000Z"
          ),
          at: "2026-08-26T03:02:00.000Z"
        }));
      cycleId = activated.cycle.cycleId;
      assert.throws(() => runtime.withImmediateTransaction(() =>
        applyRunDecisionInTransaction({
          runtime,
          runs,
          run: runs.requireProjection(runId),
          decision: nextStepDecision(activated.run.version, "agt_missing"),
          requestId: "outside-roster",
          sourceKind: "handler",
          at: "2026-08-26T03:03:00.000Z"
        })), /outside the admitted participant roster/u);
    } finally {
      runs.close();
      runtime.close();
      database.close();
    }
  }
  const recovered = new AgentRunStore(fixture.paths.database);
  try {
    assert.equal(recovered.requireProjection(runId!).status, "awaiting_orchestrator");
    assert.equal(recovered.cycle(cycleId!)?.status, "active");
  } finally {
    recovered.close();
  }
  const cancelled = cancelStewardRun(
    fixture.repo,
    runId!,
    fixture.runtimeDirectory,
    "2026-08-26T03:04:00.000Z"
  );
  assert.equal(cancelled.run.status, "cancelled");
  const afterCancel = new AgentRunStore(fixture.paths.database);
  try {
    assert.equal(afterCancel.cycle(cycleId!)?.status, "cancelled");
  } finally {
    afterCancel.close();
    fixture.close();
  }
});

test("source cycles enqueue distinct server-topic terminal deliveries", () => {
  const fixture = setup();
  const database = openRuntimeDatabase(fixture.paths.database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  try {
    const destinationId = runtimeId("dst");
    runtime.enqueueHostDelivery({
      originId: "fixture-register-source-topic",
      destinationId,
      kind: "server-topic",
      address: { topicId: "topic-fixture", agentId: "agent-fixture" },
      payload: { body: "fixture" },
      at: "2026-08-27T09:00:00.000Z"
    });
    const started = startStewardRunFromIntent(fixture.repo, {
      ...intent("source-terminal-deliveries"),
      resultDestinationRef: `destination:${destinationId}`
    }, fixture.runtimeDirectory, "2026-08-27T09:00:01.000Z");
    const bound = runtime.withImmediateTransaction(() =>
      applyRunDecisionInTransaction({
        runtime,
        runs,
        run: runs.requireProjection(started.run.runId),
        decision: awaitScheduleDecision(1),
        requestId: "bind-delivery-source",
        sourceKind: "handler",
        bindSource: ({ run }) => scheduleBinding(run),
        at: "2026-08-27T09:00:02.000Z"
      }));
    const first = runtime.withImmediateTransaction(() =>
      activateRunSourceOccurrenceInTransaction({
        runtime,
        runs,
        runId: started.run.runId,
        envelope: occurrenceEnvelope(
          bound.run,
          "delivery-occurrence-1",
          "delivery-revision-1",
          "2026-08-27T09:01:00.000Z"
        ),
        at: "2026-08-27T09:01:00.000Z"
      }));
    const firstFinished = runtime.withImmediateTransaction(() =>
      applyRunDecisionInTransaction({
        runtime,
        runs,
        run: runs.requireProjection(started.run.runId),
        decision: finishDecision(first.run.version, "cycle"),
        requestId: "finish-delivery-cycle-1",
        sourceKind: "handler",
        at: "2026-08-27T09:01:01.000Z"
      }));
    const second = runtime.withImmediateTransaction(() =>
      activateRunSourceOccurrenceInTransaction({
        runtime,
        runs,
        runId: started.run.runId,
        envelope: occurrenceEnvelope(
          firstFinished.run,
          "delivery-occurrence-2",
          "delivery-revision-2",
          "2026-08-27T09:02:00.000Z"
        ),
        at: "2026-08-27T09:02:00.000Z"
      }));
    runtime.withImmediateTransaction(() =>
      applyRunDecisionInTransaction({
        runtime,
        runs,
        run: runs.requireProjection(started.run.runId),
        decision: finishDecision(second.run.version, "cycle", "failed"),
        requestId: "finish-delivery-cycle-2",
        sourceKind: "handler",
        at: "2026-08-27T09:02:01.000Z"
      }));
    const deliveries = runtime.deliveriesForDestinationKind("server-topic")
      .filter(({ origin }) => origin.id.startsWith(`steward-run:${started.run.runId}:`));
    assert.equal(deliveries.length, 2);
    assert.equal(new Set(deliveries.map(({ origin }) => origin.id)).size, 2);
    assert.ok(deliveries.some(({ payload }) => String(payload.body).includes(": succeeded")));
    assert.ok(deliveries.some(({ payload }) => String(payload.body).includes(": failed")));
    assert.ok(deliveries.some(({ origin }) => origin.id.includes(first.cycle.cycleId)));
    assert.ok(deliveries.some(({ origin }) => origin.id.includes(second.cycle.cycleId)));
    assert.ok(deliveries.every(({ payload }) =>
      !String(payload.body).includes("cycle failed")
    ));
  } finally {
    runs.close();
    runtime.close();
    database.close();
    fixture.close();
  }
});

function intent(requestId: string) {
  return {
    schemaVersion: "RunIntent@1",
    requestId,
    objective: "Process each admitted schedule occurrence",
    acceptance: ["Each occurrence is handled exactly once"],
    contextRefs: [],
    triggerIntent: "cron",
    requestedParticipantRefs: ["agent:worker"],
    terminalEvidence: ["cycle receipt"]
  } as const;
}

function awaitScheduleDecision(expectedRunVersion: number) {
  return {
    schemaVersion: "RunDecision@3",
    action: "await_source",
    expectedRunVersion,
    rationale: "Wait for the admitted schedule",
    checkedAcceptance: [],
    state: state(),
    awaitSource: {
      sourceKind: "schedule",
      templateId: "schedule-template",
      parameters: { cron: "0 * * * *" }
    }
  } as const;
}

function finishDecision(
  expectedRunVersion: number,
  scope: "cycle" | "run",
  outcome: "succeeded" | "failed" = "succeeded"
) {
  return {
    schemaVersion: "RunDecision@3",
    action: "finish",
    expectedRunVersion,
    rationale: `Finish ${scope}`,
    checkedAcceptance: ["cycle receipt"],
    state: state(),
    finish: {
      scope,
      outcome,
      summary: outcome === "succeeded" ? `${scope} accepted` : `${scope} failed`
    }
  } as const;
}

function nextStepDecision(expectedRunVersion: number, agentId: string) {
  return {
    schemaVersion: "RunDecision@3",
    action: "next_step",
    expectedRunVersion,
    rationale: "Try an unadmitted Agent",
    checkedAcceptance: [],
    state: state(),
    nextStep: {
      target: { kind: "agent", agentId },
      mandate: { kind: "objective", objective: "Must be rejected" }
    }
  } as const;
}

function state() {
  return {
    schemaVersion: "OrchestratorState@1",
    goal: "Process occurrences",
    tasks: [],
    acceptedEvidence: [],
    unresolvedQuestions: []
  } as const;
}

function scheduleBinding(run: AgentRunProjection): RunSourceBinding {
  if (run.orchestratorBinding?.schemaVersion !== "OrchestratorBinding@3") {
    throw new Error("test requires OrchestratorBinding@3");
  }
  return {
    schemaVersion: "RunSourceBinding@1",
    runId: run.runId,
    seriesKey: `series:${run.runId}`,
    source: {
      kind: "schedule",
      id: "sch_fixture",
      definitionRevision: "definition-1"
    },
    authorityDigest: runAuthorityDigest(run.orchestratorBinding.authority),
    occurrencePolicy: "recurring",
    cancellationPolicy: "pause_source",
    reconcilePolicy: "source_owned"
  };
}

function occurrenceEnvelope(
  run: AgentRunProjection,
  occurrenceKey: string,
  sourceRevision: string,
  observedAt: string
) {
  const binding = run.sourceBinding;
  if (binding === undefined) throw new Error("test Run is not source-bound");
  return {
    schemaVersion: "TriggerOccurrenceEnvelope@1",
    source: binding.source,
    occurrenceKey,
    sourceRevision,
    observedAt,
    observation: { dueAt: observedAt },
    freshnessEvidence: [`definition:${binding.source.definitionRevision}`],
    binding: {
      runId: run.runId,
      seriesKey: binding.seriesKey,
      authorityDigest: binding.authorityDigest
    }
  } as const;
}

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-source-run-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-source-run-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-08-26T01:59:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  foundation.addAgent("codex", "codex", "2026-08-26T01:59:00.000Z");
  foundation.addAgent("worker", "codex", "2026-08-26T01:59:00.000Z");
  foundation.close();
  return {
    repo,
    runtimeDirectory,
    paths,
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}

function claim(
  runtime: RuntimeStore,
  handler: RuntimeExecution["handler"],
  at: string
): RuntimeExecution {
  const executions = runtime.claimDueExecutions(20, at);
  const execution = executions.find((candidate) => candidate.handler === handler);
  if (execution === undefined || executions.length !== 1) {
    throw new Error(`Expected one due ${handler} Execution at ${at}`);
  }
  return execution;
}
