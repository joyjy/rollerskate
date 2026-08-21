import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cancelStewardRun,
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

test("Caller decisions continue the same Run with per-Agent Sessions and finish once", async () => {
  const fixture = setup();
  const a = scriptedAgent(fixture.workspace, "a-provider", [
    step("audit complete", ["audit-evidence"]),
    step("re-review complete", ["review-evidence"])
  ]);
  const b = scriptedAgent(fixture.workspace, "b-provider", [
    step("fix complete", ["fix-evidence"])
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, a.adapter],
    [fixture.agentIds.b, b.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "caller-run",
      steward: "a",
      objective: "audit, fix and re-review",
      orchestration: { mode: "caller" },
      participantAgentIds: [fixture.agentIds.a, fixture.agentIds.b],
      maxSteps: 4
    }, fixture.runtimeDirectory, "2026-08-18T02:00:00.000Z");
    assert.equal(started.run.orchestrationMode, "caller");
    assert.equal(started.run.maxDepth, 0);
    assert.equal(started.run.orchestratorBinding?.decisionContractId, "run-decision@1");

    await harness.agent("2026-08-18T02:00:01.000Z");
    harness.result("2026-08-18T02:00:02.000Z");
    const auditCheckpoint = harness.runs.requireProjection(started.run.runId);
    assert.equal(auditCheckpoint.status, "awaiting_orchestrator");
    assert.equal(auditCheckpoint.checkpoint?.result.summary, "audit complete");
    assert.equal(auditCheckpoint.activeExecutionId, undefined);

    const self = submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "decision-self",
      decision: nextStep(auditCheckpoint.version, { kind: "self" }, "re-review")
    }, fixture.runtimeDirectory, "2026-08-18T02:00:03.000Z");
    assert.equal(self.run.status, "active");
    assert.equal(self.run.runId, started.run.runId);
    await harness.agent("2026-08-18T02:00:04.000Z");
    harness.result("2026-08-18T02:00:05.000Z");
    assert.equal(a.providerSessions[0], undefined);
    assert.equal(a.providerSessions[1], "a-provider");

    const reviewCheckpoint = harness.runs.requireProjection(started.run.runId);
    const other = submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "decision-agent",
      decision: nextStep(
        reviewCheckpoint.version,
        { kind: "agent", agentId: fixture.agentIds.b },
        "apply fix"
      )
    }, fixture.runtimeDirectory, "2026-08-18T02:00:06.000Z");
    assert.equal(other.decision.targetAgentId, fixture.agentIds.b);
    await harness.agent("2026-08-18T02:00:07.000Z");
    harness.result("2026-08-18T02:00:08.000Z");
    assert.equal(b.providerSessions[0], undefined);

    const fixCheckpoint = harness.runs.requireProjection(started.run.runId);
    const finishDecision = finish(fixCheckpoint.version, "workflow accepted");
    const finished = submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "decision-finish",
      decision: finishDecision
    }, fixture.runtimeDirectory, "2026-08-18T02:00:09.000Z");
    assert.equal(finished.run.status, "succeeded");
    assert.equal(finished.run.terminalSummary, "workflow accepted");

    const replay = submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "decision-finish",
      decision: finishDecision
    }, fixture.runtimeDirectory, "2026-08-18T02:00:10.000Z");
    assert.equal(replay.status, "duplicate");
    assert.deepEqual(replay.decision, finished.decision);
    assert.equal(harness.runs.decisions(started.run.runId).length, 3);

    const view = inspectStewardRunView(
      fixture.repo,
      started.run.runId,
      fixture.runtimeDirectory
    );
    assert.equal(view.summary.orchestrationMode, "caller");
    assert.equal(view.steps.length, 3);
    assert.equal(view.decisions.length, 3);
    assert.equal(view.steps[0]!.result?.schemaVersion, "AgentStepResult@1");
  } finally {
    harness.close();
    fixture.close();
  }
});

test("Caller decisions reject stale, ineligible and authority-expanding input", async () => {
  const fixture = setup();
  const agent = scriptedAgent(fixture.workspace, "a-provider", [step("done")]);
  const harness = runtimeHarness(fixture, new Map([[fixture.agentIds.a, agent.adapter]]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "guarded-caller-run",
      steward: "a",
      objective: "bounded work",
      orchestration: { mode: "caller" },
      participantAgentIds: [fixture.agentIds.a]
    }, fixture.runtimeDirectory, "2026-08-18T03:00:00.000Z");
    await harness.agent("2026-08-18T03:00:01.000Z");
    harness.result("2026-08-18T03:00:02.000Z");
    const checkpoint = harness.runs.requireProjection(started.run.runId);

    assert.throws(() => submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "stale",
      decision: nextStep(checkpoint.version - 1, { kind: "self" }, "retry")
    }, fixture.runtimeDirectory), /expected version/);
    assert.throws(() => submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "ineligible",
      decision: nextStep(
        checkpoint.version,
        { kind: "agent", agentId: fixture.agentIds.b },
        "escape roster"
      )
    }, fixture.runtimeDirectory), /outside the admitted participant roster/);
    assert.throws(() => submitCallerRunDecision(fixture.repo, started.run.runId, {
      requestId: "expanding",
      decision: {
        ...nextStep(checkpoint.version, { kind: "self" }, "expand"),
        workspace: { access: "write" }
      }
    }, fixture.runtimeDirectory), /unknown field: workspace/);
    assert.equal(harness.runs.requireProjection(started.run.runId).version, checkpoint.version);
    assert.equal(harness.runs.decisions(started.run.runId).length, 0);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("Malformed Worker output becomes a recoverable failed checkpoint", async () => {
  const fixture = setup();
  const agent = scriptedAgent(fixture.workspace, "a-provider", ["not-json"]);
  const harness = runtimeHarness(fixture, new Map([[fixture.agentIds.a, agent.adapter]]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "malformed-caller-run",
      steward: "a",
      objective: "return one step",
      orchestration: { mode: "caller" }
    }, fixture.runtimeDirectory, "2026-08-18T04:00:00.000Z");
    await harness.agent("2026-08-18T04:00:01.000Z");
    harness.result("2026-08-18T04:00:02.000Z");
    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "awaiting_orchestrator");
    assert.equal(run.checkpoint?.result.outcome, "failed");
    assert.match(run.checkpoint?.result.summary ?? "", /Invalid AgentStepResult@1/);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("Caller checkpoint survives Runtime restart and resumes the persisted Agent Session", async () => {
  const fixture = setup();
  const first = scriptedAgent(fixture.workspace, "a-provider", [step("checkpoint one")]);
  const firstHarness = runtimeHarness(fixture, new Map([[fixture.agentIds.a, first.adapter]]));
  let runId: string;
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "restart-caller-run",
      steward: "a",
      objective: "continue after restart",
      orchestration: { mode: "caller" }
    }, fixture.runtimeDirectory, "2026-08-18T05:00:00.000Z");
    runId = started.run.runId;
    await firstHarness.agent("2026-08-18T05:00:01.000Z");
    firstHarness.result("2026-08-18T05:00:02.000Z");
  } finally {
    firstHarness.close();
  }

  const persisted = new AgentRunStore(runtimePaths(
    fixture.repo,
    fixture.runtimeDirectory
  ).database);
  try {
    const checkpoint = persisted.requireProjection(runId!);
    assert.equal(checkpoint.status, "awaiting_orchestrator");
    submitCallerRunDecision(fixture.repo, runId!, {
      requestId: "restart-decision",
      decision: nextStep(checkpoint.version, { kind: "self" }, "resume")
    }, fixture.runtimeDirectory, "2026-08-18T05:00:03.000Z");
  } finally {
    persisted.close();
  }

  const second = scriptedAgent(fixture.workspace, "a-provider", [step("checkpoint two")]);
  const secondHarness = runtimeHarness(fixture, new Map([[fixture.agentIds.a, second.adapter]]));
  try {
    await secondHarness.agent("2026-08-18T05:00:04.000Z");
    secondHarness.result("2026-08-18T05:00:05.000Z");
    assert.equal(second.providerSessions[0], "a-provider");
    assert.equal(
      secondHarness.runs.requireProjection(runId!).checkpoint?.result.summary,
      "checkpoint two"
    );
  } finally {
    secondHarness.close();
    fixture.close();
  }
});

test("Cancel rejects a late Caller Worker result and deadline terminalizes safely", async () => {
  const fixture = setup();
  const cancelledAgent = scriptedAgent(fixture.workspace, "a-provider", [step("too late")]);
  const cancelledHarness = runtimeHarness(
    fixture,
    new Map([[fixture.agentIds.a, cancelledAgent.adapter]])
  );
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "cancelled-caller-run",
      steward: "a",
      objective: "cancel while result waits",
      orchestration: { mode: "caller" }
    }, fixture.runtimeDirectory, "2026-08-18T06:00:00.000Z");
    await cancelledHarness.agent("2026-08-18T06:00:01.000Z");
    cancelStewardRun(
      fixture.repo,
      started.run.runId,
      fixture.runtimeDirectory,
      "2026-08-18T06:00:02.000Z"
    );
    const cancelled = cancelledHarness.runs.requireProjection(started.run.runId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.checkpoint, undefined);
    assert.equal(
      cancelledHarness.runtime.audit(started.rootEventId)?.resultExecution?.status,
      "cancelled"
    );
  } finally {
    cancelledHarness.close();
  }

  const deadlineAgent = scriptedAgent(fixture.workspace, "a-provider-2", [step("late")]);
  const deadlineHarness = runtimeHarness(
    fixture,
    new Map([[fixture.agentIds.a, deadlineAgent.adapter]])
  );
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "deadline-caller-run",
      steward: "a",
      objective: "finish before deadline",
      orchestration: { mode: "caller" },
      deadlineAt: "2026-08-18T06:01:02.000Z"
    }, fixture.runtimeDirectory, "2026-08-18T06:01:00.000Z");
    await deadlineHarness.agent("2026-08-18T06:01:01.000Z");
    deadlineHarness.result("2026-08-18T06:01:03.000Z");
    const terminal = deadlineHarness.runs.requireProjection(started.run.runId);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.terminalSummary, "Agent Run deadline exhausted");
  } finally {
    deadlineHarness.close();
    fixture.close();
  }
});

function runtimeHarness(
  fixture: ReturnType<typeof setup>,
  adapters: ReadonlyMap<string, RuntimeAgentAdapter>
) {
  const database = openRuntimeDatabase(runtimePaths(
    fixture.repo,
    fixture.runtimeDirectory
  ).database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  const module = new StewardModule({ runs, runtime });
  const manifest = module.manifest();
  const agentHandler = new AgentHandler({
    store: runtime,
    adapters,
    executionGuards: manifest.executionGuards
  });
  const resultHandler = new ResultHandler(runtime, manifest.resultContinuations);
  return {
    runtime,
    runs,
    async agent(at: string) {
      await agentHandler.handle(claim(runtime, "agent", at), at);
    },
    result(at: string) {
      resultHandler.handle(claim(runtime, "result", at), at);
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
      adapterId: `caller-scripted-${providerSessionId}`,
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
            startedAt: "2026-08-18T02:00:00.000Z",
            completedAt: "2026-08-18T02:00:01.000Z",
            durationMilliseconds: 1_000
          }
        };
      }
    }
  };
}

function step(summary: string, evidence: readonly string[] = []): string {
  return JSON.stringify({
    schemaVersion: "AgentStepResult@1",
    outcome: "succeeded",
    summary,
    artifactRefs: [],
    acceptanceEvidence: evidence,
    unresolvedQuestions: []
  });
}

function nextStep(
  expectedRunVersion: number,
  target: { readonly kind: "self" } | { readonly kind: "agent"; readonly agentId: string },
  objective: string
) {
  return {
    schemaVersion: "RunDecision@1" as const,
    action: "next_step" as const,
    expectedRunVersion,
    rationale: `continue with ${objective}`,
    checkedAcceptance: [],
    nextStep: {
      target,
      mandate: { kind: "objective" as const, objective }
    }
  };
}

function finish(expectedRunVersion: number, summary: string) {
  return {
    schemaVersion: "RunDecision@1" as const,
    action: "finish" as const,
    expectedRunVersion,
    rationale: "all acceptance checked",
    checkedAcceptance: ["workflow accepted"],
    finish: { outcome: "succeeded" as const, summary }
  };
}

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-caller-run-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-caller-run-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-08-18T02:00:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  const a = foundation.addAgent("a", "codex", "2026-08-18T02:00:00.000Z");
  const b = foundation.addAgent("b", "claude-code", "2026-08-18T02:00:00.000Z");
  foundation.close();
  return {
    repo,
    runtimeDirectory,
    workspace: paths.workspace,
    agentIds: { a: a.principalId, b: b.principalId },
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}
