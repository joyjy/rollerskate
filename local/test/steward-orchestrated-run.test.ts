import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  startStewardRun,
  submitCallerRunDecision
} from "../src/application/steward/control.js";
import { StewardModule } from "../src/application/steward/module.js";
import { inspectStewardRunView } from "../src/application/steward/query.js";
import {
  AgentHandler,
  ResultHandler,
  type RuntimeAgentAdapter
} from "../src/core/runtime/handlers.js";
import type { RuntimeExecution } from "../src/core/runtime/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("default Codex Orchestrator drives a cross-Agent Run and resumes after restart", async () => {
  const fixture = setup();
  const codex = scriptedAgent(fixture.workspace, "codex-provider", [
    initialDecision(1, fixture.agentIds.kimi),
    nextDecision(3, fixture.agentIds.claude)
  ]);
  const kimi = scriptedAgent(fixture.workspace, "kimi-provider", [
    workerStep("Kimi scoped the work", ["scope accepted"])
  ]);
  const claude = scriptedAgent(fixture.workspace, "claude-provider", [
    workerStep("Claude verified the result", ["verification passed"])
  ]);
  const first = harness(fixture, new Map([
    [fixture.agentIds.codex, codex.adapter],
    [fixture.agentIds.kimi, kimi.adapter],
    [fixture.agentIds.claude, claude.adapter]
  ]));
  let runId: string;
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "default-orchestrator-run",
      objective: "scope and independently verify the result",
      taskUrl: "http://127.0.0.1:3456/tasks/41",
      maxSteps: 3
    }, fixture.runtimeDirectory, "2026-08-18T08:00:00.000Z");
    runId = started.run.runId;
    assert.equal(started.run.orchestrationMode, "caller");
    assert.equal(started.run.orchestratorBinding?.schemaVersion, "OrchestratorBinding@2");
    assert.equal(started.run.orchestratorBinding?.resultDestination?.schemaVersion,
      "RunResultDestination@2");
    assert.equal(started.run.orchestratorBinding?.resultDestination?.delivery.kind,
      "vikunja-task");
    assert.equal(started.run.stewardAgentId, fixture.agentIds.codex);
    assert.deepEqual(started.run.mandate.participantAgentIds, [
      fixture.agentIds.claude,
      fixture.agentIds.codex,
      fixture.agentIds.kimi
    ].sort());
    assert.equal(started.run.stepCount, 0);
    const rootRequest = first.runtime.event(started.rootEventId);
    assert.equal(rootRequest?.type, "agent.request");
    assert.match(rootRequest.prompt, /assignedAgentId/);
    assert.match(rootRequest.prompt, /no other task fields are allowed/);
    assert.match(rootRequest.prompt, /next Worker receives only nextStep\.mandate/u);

    await first.agent("2026-08-18T08:00:01.000Z");
    first.result("2026-08-18T08:00:02.000Z");
    await first.agent("2026-08-18T08:00:03.000Z");
    first.result("2026-08-18T08:00:04.000Z");
    await first.agent("2026-08-18T08:00:05.000Z");
    first.result("2026-08-18T08:00:06.000Z");
    await first.agent("2026-08-18T08:00:07.000Z");
    first.result("2026-08-18T08:00:08.000Z");

    const awaiting = first.runs.requireProjection(runId);
    assert.equal(awaiting.status, "awaiting_orchestrator");
    assert.equal(awaiting.checkpoint?.agentId, fixture.agentIds.claude);
    assert.equal(awaiting.stepCount, 2);
    assert.equal(first.runs.decisions(runId).length, 2);
    assert.deepEqual(codex.providerSessions, [undefined, "codex-provider"]);
  } finally {
    first.close();
  }

  rewriteRunDestinationAsLegacy(
    fixture,
    runId!,
    "http://127.0.0.1:3456/tasks/41"
  );

  const resumedCodex = scriptedAgent(fixture.workspace, "codex-provider", [finishDecision(5)]);
  const second = harness(fixture, new Map([
    [fixture.agentIds.codex, resumedCodex.adapter],
    [fixture.agentIds.kimi, scriptedAgent(fixture.workspace, "kimi-provider", []).adapter],
    [fixture.agentIds.claude, scriptedAgent(fixture.workspace, "claude-provider", []).adapter]
  ]));
  try {
    await second.agent("2026-08-18T08:00:09.000Z");
    second.result("2026-08-18T08:00:10.000Z");

    const terminal = second.runs.requireProjection(runId!);
    assert.equal(terminal.orchestratorBinding?.schemaVersion, "OrchestratorBinding@2");
    assert.equal(terminal.orchestratorBinding?.resultDestination?.schemaVersion,
      "RunResultDestination@2");
    assert.equal(terminal.status, "succeeded");
    assert.equal(terminal.terminalSummary, "Cross-Agent verification accepted");
    assert.deepEqual(resumedCodex.providerSessions, ["codex-provider"]);
    const decisions = second.runs.decisions(runId!);
    assert.equal(decisions.length, 3);
    assert.equal(decisions[0]!.decision.schemaVersion, "RunDecision@2");
    assert.equal(decisions[0]!.decision.state.tasks.length, 2);
    assert.equal(decisions[2]!.decision.schemaVersion, "RunDecision@2");
    assert.equal(decisions[2]!.decision.state.tasks[0]!.status, "pending");

    const delivery = second.runtime.deliveriesForDestinationKind("vikunja-task")[0];
    assert.equal(delivery?.status, "pending");
    assert.equal(delivery?.payload.runId, runId);
    assert.equal(second.runtime.destination(delivery!.destinationId)?.address.taskUrl,
      "http://127.0.0.1:3456/tasks/41");

    const view = inspectStewardRunView(fixture.repo, runId!, fixture.runtimeDirectory);
    assert.equal(view.steps.length, 5);
    assert.equal(view.orchestrationHistory.length, 3);
    assert.equal(view.steps[0]!.result?.schemaVersion, "RunDecision@2");
    assert.equal(view.outputFolders[0]?.outputs.at(-1)?.kind, "primary");
    assert.equal(view.outputFolders[0]?.outputs.at(-1)?.value,
      "Cross-Agent verification accepted");
  } finally {
    second.close();
    fixture.close();
  }
});

test("manual Owner cannot replace an active Worker as an initial decision", async () => {
  const fixture = setup();
  const codex = scriptedAgent(fixture.workspace, "codex-active-worker", [
    initialDecision(1, fixture.agentIds.kimi)
  ]);
  const runtime = harness(fixture, new Map([
    [fixture.agentIds.codex, codex.adapter],
    [fixture.agentIds.kimi, scriptedAgent(fixture.workspace, "kimi-active", [
      workerStep("Worker should remain active")
    ]).adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "active-worker-cas-run",
      objective: "keep the admitted Worker active",
      participantAgentIds: [fixture.agentIds.codex, fixture.agentIds.kimi]
    }, fixture.runtimeDirectory, "2026-08-18T08:30:00.000Z");
    await runtime.agent("2026-08-18T08:30:01.000Z");
    runtime.result("2026-08-18T08:30:02.000Z");

    const active = runtime.runs.requireProjection(started.run.runId);
    assert.equal(active.status, "active");
    assert.equal(active.stepCount, 1);
    assert.equal(active.checkpoint, undefined);
    assert.equal(runtime.runs.decisions(started.run.runId).length, 1);

    assert.throws(() => submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "owner-must-not-replace-worker",
      decision: {
        schemaVersion: "RunDecision@1",
        action: "finish",
        expectedRunVersion: active.version,
        rationale: "This must be rejected while the Worker is active",
        checkedAcceptance: [],
        finish: { outcome: "succeeded", summary: "Incorrect early finish" }
      }
    }, fixture.runtimeDirectory, "2026-08-18T08:30:03.000Z"), /not awaiting a decision/u);

    const unchanged = runtime.runs.requireProjection(started.run.runId);
    assert.equal(unchanged.version, active.version);
    assert.equal(unchanged.activeStepId, active.activeStepId);
    assert.equal(runtime.runs.decisions(started.run.runId).length, 1);
  } finally {
    runtime.close();
    fixture.close();
  }
});

test("a historical internal decision is rejected while manual v1 fallback remains available", async () => {
  const fixture = setup();
  const codex = scriptedAgent(fixture.workspace, "codex-fallback", [
    "not-json"
  ]);
  const runtime = harness(fixture, new Map([[fixture.agentIds.codex, codex.adapter]]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "manual-fallback-run",
      objective: "finish through fallback",
      taskUrl: "http://127.0.0.1:3456/tasks/42",
      participantAgentIds: [fixture.agentIds.codex]
    }, fixture.runtimeDirectory, "2026-08-18T09:00:00.000Z");
    await runtime.agent("2026-08-18T09:00:01.000Z");
    runtime.result("2026-08-18T09:00:02.000Z");
    const checkpoint = runtime.runs.requireProjection(started.run.runId);
    assert.equal(checkpoint.status, "awaiting_orchestrator");
    assert.equal(checkpoint.checkpoint, undefined);
    assert.equal(checkpoint.stepCount, 0);
    assert.equal(runtime.runs.decisions(started.run.runId).length, 0);

    assert.throws(() => submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "owner-cannot-forge-orchestrator-state",
      decision: JSON.parse(finishDecision(checkpoint.version)) as Readonly<Record<string, unknown>>
    }, fixture.runtimeDirectory, "2026-08-18T09:00:02.500Z"),
    /Historical spec requires an explicit persisted-data reader/u);

    const finished = submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "owner-recovery",
      decision: {
        schemaVersion: "RunDecision@1",
        action: "needs_human",
        expectedRunVersion: checkpoint.version,
        rationale: "Owner inspected the durable checkpoint",
        checkedAcceptance: ["checkpoint retained"]
      }
    }, fixture.runtimeDirectory, "2026-08-18T09:00:03.000Z");
    assert.equal(finished.run.status, "needs_human");
    const delivery = runtime.runtime.deliveriesForDestinationKind("vikunja-task")[0];
    assert.equal(delivery?.status, "pending");
    assert.match(String(delivery?.payload.body), /needs_human/u);
    assert.match(String(delivery?.payload.body), /Owner inspected the durable checkpoint/u);
  } finally {
    runtime.close();
    fixture.close();
  }
});

function nextDecision(expectedRunVersion: number, targetAgentId: string): string {
  return JSON.stringify({
    schemaVersion: "RunDecision@2",
    action: "next_step",
    expectedRunVersion,
    rationale: "Independent verification is still required",
    checkedAcceptance: ["scope accepted"],
    state: {
      schemaVersion: "OrchestratorState@1",
      goal: "scope and independently verify the result",
      tasks: [
        { taskId: "scope", objective: "Scope the work", status: "completed", summary: "Scoped" },
        { taskId: "verify", objective: "Verify independently", status: "pending", assignedAgentId: targetAgentId }
      ],
      acceptedEvidence: ["scope accepted"],
      unresolvedQuestions: []
    },
    nextStep: {
      target: { kind: "agent", agentId: targetAgentId },
      mandate: { kind: "objective", objective: "Independently verify the scoped result" }
    }
  });
}

function initialDecision(expectedRunVersion: number, targetAgentId: string): string {
  return JSON.stringify({
    schemaVersion: "RunDecision@2",
    action: "next_step",
    expectedRunVersion,
    rationale: "The goal needs a scoped implementation step followed by independent verification",
    checkedAcceptance: [],
    state: {
      schemaVersion: "OrchestratorState@1",
      goal: "scope and independently verify the result",
      tasks: [
        { taskId: "scope", objective: "Scope the work", status: "pending", assignedAgentId: targetAgentId },
        { taskId: "verify", objective: "Verify independently", status: "pending" }
      ],
      acceptedEvidence: [],
      unresolvedQuestions: []
    },
    nextStep: {
      target: { kind: "agent", agentId: targetAgentId },
      mandate: { kind: "objective", objective: "Scope the work and return bounded evidence" }
    }
  });
}

function finishDecision(expectedRunVersion: number): string {
  return JSON.stringify({
    schemaVersion: "RunDecision@2",
    action: "finish",
    expectedRunVersion,
    rationale: "Both bounded tasks are complete",
    checkedAcceptance: ["scope accepted", "verification passed"],
    state: {
      schemaVersion: "OrchestratorState@1",
      goal: "scope and independently verify the result",
      tasks: [
        { taskId: "scope", objective: "Scope the work", status: "completed", summary: "Scoped" },
        { taskId: "verify", objective: "Verify independently", status: "completed", summary: "Verified" }
      ],
      acceptedEvidence: ["scope accepted", "verification passed"],
      unresolvedQuestions: []
    },
    finish: { outcome: "succeeded", summary: "Cross-Agent verification accepted" }
  });
}

function workerStep(summary: string, evidence: readonly string[] = []): string {
  return JSON.stringify({
    schemaVersion: "AgentStepResult@1",
    outcome: "succeeded",
    summary,
    artifactRefs: [],
    acceptanceEvidence: evidence,
    unresolvedQuestions: []
  });
}

function scriptedAgent(
  workspace: string,
  providerSessionId: string,
  outputs: readonly string[]
): {
  readonly adapter: RuntimeAgentAdapter;
  readonly providerSessions: Array<string | undefined>;
} {
  const providerSessions: Array<string | undefined> = [];
  let index = 0;
  return {
    providerSessions,
    adapter: {
      adapterId: `steward-scripted-${providerSessionId}`,
      workspace,
      async invoke(input) {
        providerSessions.push(input.providerSessionId);
        const body = outputs[index++];
        if (body === undefined) throw new Error("scripted output exhausted");
        return {
          providerSessionId,
          outcome: { kind: "message", body },
          invocation: {
            schemaVersion: "AgentInvocationDiagnostics@1",
            effectivePrompt: input.event.prompt,
            startedAt: "2026-08-18T08:00:00.000Z",
            completedAt: "2026-08-18T08:00:01.000Z",
            durationMilliseconds: 1_000
          }
        };
      }
    }
  };
}

function harness(
  fixture: ReturnType<typeof setup>,
  adapters: ReadonlyMap<string, RuntimeAgentAdapter>
) {
  const database = openRuntimeDatabase(runtimePaths(
    fixture.repo,
    fixture.runtimeDirectory
  ).database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  const manifest = new StewardModule({ runs, runtime }).manifest();
  const agents = new AgentHandler({
    store: runtime,
    adapters,
    executionGuards: manifest.executionGuards
  });
  const results = new ResultHandler(runtime, manifest.resultContinuations);
  return {
    runtime,
    runs,
    async agent(at: string) {
      await agents.handle(claim(runtime, "agent", at), at);
    },
    result(at: string) {
      results.handle(claim(runtime, "result", at), at);
    },
    close() {
      runs.close();
      runtime.close();
      database.close();
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

function rewriteRunDestinationAsLegacy(
  fixture: ReturnType<typeof setup>,
  runId: string,
  taskUrl: string
): void {
  const database = openRuntimeDatabase(runtimePaths(
    fixture.repo,
    fixture.runtimeDirectory
  ).database);
  try {
    const row = database.prepare(`
      SELECT orchestrator_binding_json FROM agent_runs WHERE run_id = ?
    `).get(runId) as { orchestrator_binding_json: string } | undefined;
    if (row === undefined) throw new Error(`Agent Run not found: ${runId}`);
    const binding = JSON.parse(row.orchestrator_binding_json) as Record<string, unknown>;
    const destination = binding.resultDestination as Record<string, unknown>;
    database.prepare(`
      UPDATE agent_runs SET orchestrator_binding_json = ? WHERE run_id = ?
    `).run(JSON.stringify({
      ...binding,
      resultDestination: {
        schemaVersion: "VikunjaTaskResultDestination@1",
        destinationId: destination.destinationId,
        taskUrl
      }
    }), runId);
  } finally {
    database.close();
  }
}

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-steward-orchestrator-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-steward-orchestrator-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-08-18T08:00:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  const codex = foundation.addAgent("codex", "codex", "2026-08-18T08:00:00.000Z");
  const kimi = foundation.addAgent("kimi", "kimi-code", "2026-08-18T08:00:00.000Z");
  const claude = foundation.addAgent("claude", "claude-code", "2026-08-18T08:00:00.000Z");
  foundation.close();
  return {
    repo,
    runtimeDirectory,
    workspace: paths.workspace,
    agentIds: {
      codex: codex.principalId,
      kimi: kimi.principalId,
      claude: claude.principalId
    },
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}
