import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cancelStewardRun,
  closeStewardRunSeries,
  startStewardRun
} from "../src/application/steward/control.js";
import { StewardModule } from "../src/application/steward/module.js";
import { inspectStewardRunView } from "../src/application/steward/query.js";
import {
  AgentHandler,
  ResultHandler,
  type RuntimeAgentAdapter
} from "../src/core/runtime/handlers.js";
import {
  AgentInvocationError,
  type AgentInvocationFailure,
  type AgentInvocationProgress
} from "../src/core/runtime/agent-invocation.js";
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

test("Steward Run persists explicit network authority in its workspace grant", () => {
  const fixture = setup();
  try {
    execFileSync("git", ["init", fixture.workspace]);
    execFileSync("git", ["-C", fixture.workspace, "-c", "user.name=Test", "-c",
      "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture"]);
    const started = startStewardRun(fixture.repo, {
      requestId: "network-authority-run",
      steward: "a",
      objective: "Use an authenticated external API",
      workspace: {
        root: fixture.workspace,
        access: "write",
        effect: "may_remain_unchanged",
        networkAccess: true
      },
      maxDepth: 0
    }, fixture.runtimeDirectory, "2026-08-13T10:00:00.000Z");

    assert.equal(started.run.workspaceGrant?.networkAccess, true);
    const runtime = new RuntimeStore(runtimePaths(
      fixture.repo,
      fixture.runtimeDirectory
    ).database);
    try {
      const root = runtime.event(started.rootEventId);
      assert.equal(
        root?.type === "agent.request"
          ? root.runContext?.workspaceGrant?.networkAccess
          : undefined,
        true
      );
    } finally {
      runtime.close();
    }
    assert.throws(() => startStewardRun(fixture.repo, {
      requestId: "invalid-network-authority-run",
      steward: "a",
      objective: "Invalid read-only network request",
      workspace: {
        root: fixture.workspace,
        access: "read",
        networkAccess: true
      },
      maxDepth: 0
    }, fixture.runtimeDirectory), /requires workspace\.access=write/);
    assert.throws(() => startStewardRun(fixture.repo, {
      requestId: "delegating-network-authority-run",
      steward: "a",
      objective: "Invalid delegating network request",
      workspace: {
        root: fixture.workspace,
        access: "write",
        effect: "may_remain_unchanged",
        networkAccess: true
      },
      maxDepth: 1
    }, fixture.runtimeDirectory), /requires maxDepth=0/);
    assert.throws(() => startStewardRun(fixture.repo, {
      requestId: "unsupported-client-network-authority-run",
      steward: "b",
      objective: "Invalid non-Codex network request",
      workspace: {
        root: fixture.workspace,
        access: "write",
        effect: "may_remain_unchanged",
        networkAccess: true
      },
      maxDepth: 0
    }, fixture.runtimeDirectory), /requires a Codex Steward/);
  } finally {
    fixture.close();
  }
});

test("nested delegates use run-scoped Sessions and callbacks restore exact callers", async () => {
  const fixture = setup();
  const a = scriptedAgent(fixture.workspace, "a-provider", [
    delegate(fixture.agentIds.b, "ask B"),
    complete("A finished")
  ]);
  const b = scriptedAgent(fixture.workspace, "b-provider", [
    delegate(fixture.agentIds.c, "ask C"),
    complete("B finished")
  ]);
  const c = scriptedAgent(fixture.workspace, "c-provider", [
    complete("C finished")
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, a.adapter],
    [fixture.agentIds.b, b.adapter],
    [fixture.agentIds.c, c.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "nested-run",
      steward: "a",
      objective: "Complete nested work",
      maxSteps: 10,
      maxDepth: 4
    }, fixture.runtimeDirectory, "2026-07-26T00:00:00.000Z");

    await harness.agent("2026-07-26T00:00:01.000Z");
    harness.result("2026-07-26T00:00:02.000Z");
    await harness.agent("2026-07-26T00:00:03.000Z");
    harness.result("2026-07-26T00:00:04.000Z");
    await harness.agent("2026-07-26T00:00:05.000Z");
    harness.result("2026-07-26T00:00:06.000Z");
    await harness.agent("2026-07-26T00:00:07.000Z");
    harness.result("2026-07-26T00:00:08.000Z");
    await harness.agent("2026-07-26T00:00:09.000Z");
    harness.result("2026-07-26T00:00:10.000Z");

    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.stepCount, 5);
    const sessions = harness.runtime.sessions(20).filter(
      (session) => session.runId === run.runId
    );
    assert.equal(sessions.length, 3);
    assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 3);
    assert.equal(a.providerSessions[0], undefined);
    assert.equal(a.providerSessions[1], "a-provider");
    assert.equal(b.providerSessions[0], undefined);
    assert.equal(b.providerSessions[1], "b-provider");
    assert.equal(c.providerSessions[0], undefined);

    const view = inspectStewardRunView(
      fixture.repo,
      run.runId,
      fixture.runtimeDirectory
    );
    assert.deepEqual(
      view.exchanges.map(({ fromAgentId, toAgentId, kind }) =>
        ({ fromAgentId, toAgentId, kind })),
      [
        { fromAgentId: fixture.agentIds.a, toAgentId: fixture.agentIds.b, kind: "delegate" },
        { fromAgentId: fixture.agentIds.b, toAgentId: fixture.agentIds.c, kind: "delegate" },
        { fromAgentId: fixture.agentIds.c, toAgentId: fixture.agentIds.b, kind: "callback" },
        { fromAgentId: fixture.agentIds.b, toAgentId: fixture.agentIds.a, kind: "callback" }
      ]
    );
    assert.equal(view.timeline.filter(
      ({ event }) => event.type === "agent.request"
    ).length, 5);
    assert.equal(view.steps.length, 5);
    assert.equal(view.steps[0]!.agent.handle, "a");
    assert.equal(
      view.steps[0]!.result?.schemaVersion === "AgentTurnResult@1"
        ? view.steps[0]!.result.action
        : undefined,
      "delegate"
    );
    assert.equal(view.steps[0]!.effectivePrompt, view.steps[0]!.prompt);
    assert.deepEqual(view.steps[0]!.invocation?.toolUsage, [
      { name: "Read", count: 1 }
    ]);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("MR series reuses one Run, isolates revision Sessions, and can revisit one revision", async () => {
  const fixture = setup();
  const reviewer = scriptedAgent(fixture.workspace, "mr-reviewer", [
    complete("revision one is ready"),
    complete("revision one quality review complete"),
    complete("revision two is ready")
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, reviewer.adapter]
  ]));
  const series = { key: "gitlab-mr:example/project!42", sourceRevision: "sha-1" };
  try {
    const readiness = startStewardRun(fixture.repo, {
      requestId: "mr-42-sha-1-readiness",
      series,
      steward: "a",
      objective: "Summarize the change and decide whether it is complete"
    }, fixture.runtimeDirectory, "2026-08-20T01:00:00.000Z");
    await harness.agent("2026-08-20T01:00:01.000Z");
    harness.result("2026-08-20T01:00:02.000Z");

    const waiting = harness.runs.requireProjection(readiness.run.runId);
    assert.equal(waiting.status, "awaiting_source");
    assert.equal(waiting.activeCycleId, undefined);
    const firstCycle = harness.runs.cycles(waiting.runId)[0]!;
    assert.equal(firstCycle.sourceRevision, "sha-1");
    assert.equal(firstCycle.status, "succeeded");

    const quality = startStewardRun(fixture.repo, {
      requestId: "mr-42-sha-1-quality",
      series,
      steward: "a",
      objective: "Perform the requested quality review"
    }, fixture.runtimeDirectory, "2026-08-20T01:01:00.000Z");
    assert.equal(quality.run.runId, readiness.run.runId);
    assert.equal(quality.run.activeCycleId, firstCycle.cycleId);
    await harness.agent("2026-08-20T01:01:01.000Z");
    harness.result("2026-08-20T01:01:02.000Z");

    const nextRevision = startStewardRun(fixture.repo, {
      requestId: "mr-42-sha-2-readiness",
      series: { ...series, sourceRevision: "sha-2" },
      steward: "a",
      objective: "Summarize the updated change and decide whether it is complete"
    }, fixture.runtimeDirectory, "2026-08-20T01:02:00.000Z");
    assert.equal(nextRevision.run.runId, readiness.run.runId);
    assert.notEqual(nextRevision.run.activeCycleId, firstCycle.cycleId);
    await harness.agent("2026-08-20T01:02:01.000Z");
    assert.equal(
      harness.runtime.executionForEvent(nextRevision.rootEventId)?.status,
      "succeeded",
      harness.runtime.executionForEvent(nextRevision.rootEventId)?.lastError
    );
    harness.result("2026-08-20T01:02:02.000Z");

    const cycles = harness.runs.cycles(readiness.run.runId);
    assert.deepEqual(cycles.map((cycle) => cycle.sourceRevision), ["sha-2", "sha-1"]);
    assert.deepEqual(reviewer.providerSessions, [undefined, "mr-reviewer", undefined]);
    const sessions = harness.runtime.sessions(20).filter(
      (session) => session.runId === readiness.run.runId
    );
    assert.equal(sessions.length, 2);
    assert.equal(new Set(sessions.map((session) => session.cycleId)).size, 2);
    assert.equal(harness.runs.eventIds(readiness.run.runId).filter((eventId) =>
      harness.runtime.event(eventId)?.type === "agent.request").length, 3);
    const closed = closeStewardRunSeries(
      fixture.repo,
      readiness.run.runId,
      "MR merged",
      fixture.runtimeDirectory,
      "2026-08-20T01:03:00.000Z"
    );
    assert.equal(closed.status, "closed");
    assert.equal(closed.run.status, "succeeded");
    assert.throws(() => startStewardRun(fixture.repo, {
      requestId: "mr-42-sha-3-readiness",
      series: { ...series, sourceRevision: "sha-3" },
      steward: "a",
      objective: "Must not reopen a merged MR"
    }, fixture.runtimeDirectory), /series is terminal/);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("forum@1 reuses sequential Run continuation and stops on no information delta", async () => {
  const fixture = setup();
  const steward = scriptedAgent(fixture.workspace, "forum-steward", [
    delegate(fixture.agentIds.b, "Challenge the proposed answer with one material objection"),
    complete("No information delta remains; synthesis accepted the corrected answer")
  ]);
  const challenger = scriptedAgent(fixture.workspace, "forum-challenger", [
    complete("One assumption was corrected with evidence")
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, steward.adapter],
    [fixture.agentIds.b, challenger.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "forum-sequential-run",
      steward: "a",
      workflowRef: "forum@1",
      inputs: {
        objective: "Choose the safer design",
        projectAdmission: { schemaVersion: "ProjectRunAdmission@1" }
      },
      participantAgentIds: [fixture.agentIds.a, fixture.agentIds.b],
      maxSteps: 6,
      maxDepth: 2
    }, fixture.runtimeDirectory, "2026-08-13T03:00:00.000Z");

    await harness.agent("2026-08-13T03:00:01.000Z");
    harness.result("2026-08-13T03:00:02.000Z");
    await harness.agent("2026-08-13T03:00:03.000Z");
    harness.result("2026-08-13T03:00:04.000Z");
    await harness.agent("2026-08-13T03:00:05.000Z");
    harness.result("2026-08-13T03:00:06.000Z");

    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.stepCount, 3);
    assert.match(run.terminalSummary ?? "", /No information delta/);
    assert.equal(harness.runtime.sessions(20).filter(
      (session) => session.runId === run.runId
    ).length, 2);
    const view = inspectStewardRunView(fixture.repo, run.runId, fixture.runtimeDirectory);
    assert.deepEqual(view.exchanges.map(({ kind }) => kind), ["delegate", "callback"]);
    assert.doesNotMatch(view.steps[0]!.prompt, new RegExp(fixture.agentIds.c));
  } finally {
    harness.close();
    fixture.close();
  }
});

test("review@1 keeps the WorkItem revision in one read-only structured Run", async () => {
  const fixture = setup();
  execFileSync("git", ["init", "-q"], { cwd: fixture.workspace });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-m", "fixture"], { cwd: fixture.workspace });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.workspace,
    encoding: "utf8"
  }).trim();
  const outputs: string[] = [];
  const reviewer = scriptedAgent(fixture.workspace, "review-provider", outputs);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, reviewer.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "workitem-review-revision-1",
      steward: "a",
      workflowRef: "review@1",
      inputs: {
        workitem_id: "WI-review-1",
        revision_token: "revision-1",
        expected_head_sha: head,
        goal: "Review the isolated fixture",
        acceptance: ["structured result"],
        checks: ["revision unchanged"],
        constraints: ["read-only"]
      },
      workspace: { root: fixture.workspace, access: "read" },
      maxSteps: 4,
      maxDepth: 0,
      orchestration: { mode: "autonomous" }
    }, fixture.runtimeDirectory, "2026-08-19T01:00:00.000Z");
    outputs.push(JSON.stringify({
      schemaVersion: "AgentTurnResult@1",
      action: "complete",
      outcome: "succeeded",
      summary: "Verdict: pass; fixture revision and acceptance checks verified.",
      artifactRefs: ["artifact://review-result/WI-review-1"],
      outputs: [{
        id: "result",
        title: "Review result",
        contentType: "application/json",
        schemaVersion: "ReviewResult@1",
        value: { verdict: "pass", revision: "revision-1" }
      }]
    }));

    await harness.agent("2026-08-19T01:00:01.000Z");
    harness.result("2026-08-19T01:00:02.000Z");

    const view = inspectStewardRunView(fixture.repo, started.run.runId, fixture.runtimeDirectory);
    assert.equal(view.summary.status, "succeeded");
    assert.equal(view.summary.orchestrationMode, "autonomous");
    assert.equal(view.summary.mandate.workflowRef, "review@1");
    assert.equal(view.projection.mandate.kind, "workflow");
    assert.equal(
      view.projection.mandate.kind === "workflow"
        ? view.projection.mandate.inputs.revision_token
        : undefined,
      "revision-1"
    );
    assert.equal(
      view.currentWorkspaceRevision?.revision,
      view.summary.workspace?.admittedRevision
    );
    assert.equal(
      view.steps.at(-1)?.observedWorkspaceRevision,
      view.summary.workspace?.admittedRevision
    );
    assert.equal(view.currentWorkspaceRevision?.head, head);
    const terminalResult = view.steps.at(-1)?.result;
    assert.deepEqual(view.outputFolders[0]?.outputs.map((output) => ({
      outputId: output.outputId,
      kind: output.kind,
      schemaVersion: output.schemaVersion
    })), [{
      outputId: `${view.steps.at(-1)?.stepId}:primary`,
      kind: "primary",
      schemaVersion: null
    }, {
      outputId: `${view.steps.at(-1)?.stepId}:output:result`,
      kind: "output",
      schemaVersion: "ReviewResult@1"
    }, {
      outputId: `${view.steps.at(-1)?.stepId}:artifact-1`,
      kind: "reference",
      schemaVersion: null
    }]);
    assert.deepEqual(
      terminalResult !== null && terminalResult !== undefined && "artifactRefs" in terminalResult
        ? terminalResult.artifactRefs
        : undefined,
      ["artifact://review-result/WI-review-1"]
    );
    assert.match(view.steps[0]!.prompt, /revision-1/);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("forum@1 step budget stops before admitting another child", async () => {
  const fixture = setup();
  const steward = scriptedAgent(fixture.workspace, "forum-budget", [
    delegate(fixture.agentIds.b, "Unadmitted budget-overflow child")
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, steward.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "forum-budget-run",
      steward: "a",
      workflowRef: "forum@1",
      inputs: { objective: "Bounded question" },
      participantAgentIds: [fixture.agentIds.a, fixture.agentIds.b],
      maxSteps: 1,
      maxDepth: 2
    }, fixture.runtimeDirectory, "2026-08-13T04:00:00.000Z");
    await harness.agent("2026-08-13T04:00:01.000Z");
    harness.result("2026-08-13T04:00:02.000Z");
    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "failed");
    assert.equal(run.terminalSummary, "Agent Run step budget exhausted");
    assert.equal(harness.runs.eventIds(run.runId).filter((eventId) =>
      harness.runtime.event(eventId)?.type === "agent.request").length, 1);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("cancel does not kill a running provider but suppresses retry and callback", async () => {
  const fixture = setup();
  let rejectProvider!: (error: Error) => void;
  let invoked!: () => void;
  const invokedPromise = new Promise<void>((resolve) => {
    invoked = resolve;
  });
  const adapter: RuntimeAgentAdapter = {
    adapterId: "controlled-agent",
    workspace: fixture.workspace,
    invoke() {
      invoked();
      return new Promise((_, reject) => {
        rejectProvider = reject;
      });
    }
  };
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "cancel-running",
      steward: "a",
      objective: "wait"
    }, fixture.runtimeDirectory, "2026-07-26T01:00:00.000Z");
    const handling = harness.agent("2026-07-26T01:00:01.000Z");
    await invokedPromise;
    const cancelled = cancelStewardRun(
      fixture.repo,
      started.run.runId,
      fixture.runtimeDirectory,
      "2026-07-26T01:00:02.000Z"
    );
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.cancelledExecutions, 0);
    rejectProvider(new Error("late provider failure"));
    await handling;
    const agentExecution = harness.runtime.executionForEvent(started.rootEventId)!;
    assert.equal(agentExecution.status, "failed");
    assert.notEqual(agentExecution.status, "retry_wait");
    harness.result("2026-07-26T01:00:03.000Z");
    assert.equal(harness.runs.requireProjection(started.run.runId).status, "cancelled");
    assert.equal(harness.runs.eventIds(started.run.runId).filter((eventId) =>
      harness.runtime.event(eventId)?.type === "agent.request").length, 1);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("Core persists Agent Run output opaquely before the module validates its contract", async () => {
  const fixture = setup();
  const malformedOutput = "this is not AgentTurnResult JSON";
  const agent = scriptedAgent(fixture.workspace, "opaque-provider", [
    malformedOutput,
    adjudicationAccept(complete("normalized result accepted"))
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, agent.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "opaque-result",
      steward: "a",
      objective: "return malformed output"
    }, fixture.runtimeDirectory, "2026-07-26T02:00:00.000Z");

    await harness.agent("2026-07-26T02:00:01.000Z");

    const audit = harness.runtime.audit(started.rootEventId)!;
    assert.equal(audit.execution?.status, "succeeded");
    assert.equal(audit.resultEvent?.outcome, "succeeded");
    assert.equal(audit.resultEvent?.output, malformedOutput);
    assert.equal(harness.database.prepare(
      "SELECT payload_json FROM events WHERE event_id = ?"
    ).get(audit.resultEvent!.eventId)!.payload_json, null);

    harness.result("2026-07-26T02:00:02.000Z");
    const handled = harness.runtime.audit(started.rootEventId)!.resultExecution!;
    assert.equal(handled.status, "succeeded");
    const receipt = harness.database.prepare(
      "SELECT receipt_json FROM executions WHERE execution_id = ?"
    ).get(handled.executionId) as { receipt_json: string };
    assert.equal(JSON.parse(receipt.receipt_json).outcome, "adjudication_requested");
    const adjudicating = harness.runs.requireProjection(started.run.runId);
    assert.equal(adjudicating.status, "active");
    const recoveryRequest = harness.runtime.eventsForRoot(started.rootEventId)
      .find((event) => event.type === "agent.request" &&
        event.runContext?.resultContractId === "agent-turn-adjudication@1");
    assert.equal(recoveryRequest?.type, "agent.request");
    assert.equal(harness.runtime.executionForEvent(recoveryRequest!.eventId)?.maxAttempts, 1);
    assert.match(recoveryRequest!.type === "agent.request" ? recoveryRequest!.prompt : "",
      /Do not call tools/);

    await harness.agent("2026-07-26T02:00:03.000Z");
    harness.result("2026-07-26T02:00:04.000Z");
    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.terminalSummary, "normalized result accepted");
    const view = inspectStewardRunView(
      fixture.repo,
      run.runId,
      fixture.runtimeDirectory
    );
    assert.equal(view.outputFolders.flatMap((folder) => folder.outputs)
      .some((output) => output.value === "normalized result accepted"), true);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("Steward acceptance preserves the original child result identity before callback", async () => {
  const fixture = setup();
  const steward = scriptedAgent(fixture.workspace, "accept-child-steward", [
    delegate(fixture.agentIds.b, "ask B"),
    adjudicationAccept(complete("B result normalized")),
    complete("A finished")
  ]);
  const child = scriptedAgent(fixture.workspace, "accept-child-worker", [
    "B returned malformed output"
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, steward.adapter],
    [fixture.agentIds.b, child.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "accept-child-result",
      steward: "a",
      objective: "complete delegated work",
      maxDepth: 2
    }, fixture.runtimeDirectory, "2026-08-13T04:25:00.000Z");
    await harness.agent("2026-08-13T04:25:01.000Z");
    harness.result("2026-08-13T04:25:02.000Z");
    await harness.agent("2026-08-13T04:25:03.000Z");
    const childResult = harness.runtime.audit(
      harness.runtime.eventsForRoot(started.rootEventId)
        .find((event) => event.type === "agent.request" && event.agentId === fixture.agentIds.b)!
        .eventId
    )!.resultEvent!;
    harness.result("2026-08-13T04:25:04.000Z");
    await harness.agent("2026-08-13T04:25:05.000Z");
    harness.result("2026-08-13T04:25:06.000Z");

    const callback = harness.runtime.eventsForRoot(started.rootEventId)
      .find((event) => event.type === "agent.request" &&
        event.runContext?.stepCompletion !== undefined);
    assert.equal(callback?.type, "agent.request");
    assert.equal(callback!.type === "agent.request"
      ? callback!.runContext?.stepCompletion?.childResultEventId
      : undefined, childResult.eventId);
    assert.equal(harness.runtime.event(childResult.eventId)?.agentId, fixture.agentIds.b);
    await harness.agent("2026-08-13T04:25:07.000Z");
    harness.result("2026-08-13T04:25:08.000Z");
    assert.equal(harness.runs.requireProjection(started.run.runId).status, "succeeded");
  } finally {
    harness.close();
    fixture.close();
  }
});

test("startup recovery emits one adjudication request without replaying interrupted work", () => {
  const fixture = setup();
  const harness = runtimeHarness(fixture, new Map());
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "interrupted-agent-run",
      steward: "a",
      objective: "perform one provider-backed turn"
    }, fixture.runtimeDirectory, "2026-08-13T04:20:00.000Z");
    const running = claim(harness.runtime, "agent", "2026-08-13T04:20:01.000Z");
    assert.equal(running.maxAttempts, 1);

    assert.equal(
      harness.runtime.reconcileInterrupted("2026-08-13T04:20:02.000Z"),
      1
    );
    assert.equal(harness.runtime.execution(running.executionId)?.status, "failed");
    harness.result("2026-08-13T04:20:03.000Z");

    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "active");
    const requests = harness.runtime.eventsForRoot(started.rootEventId)
      .filter((event) => event.type === "agent.request");
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.type === "agent.request"
      ? requests[1].runContext?.resultContractId
      : undefined, "agent-turn-adjudication@1");
    assert.equal(harness.runtime.executionForEvent(requests[1]!.eventId)?.maxAttempts, 1);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("Runtime exposes bounded in-flight progress without persisting streamed payloads", () => {
  const fixture = setup();
  const harness = runtimeHarness(fixture, new Map());
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "bounded-in-flight-progress",
      steward: "a",
      objective: "observe one bounded provider turn"
    }, fixture.runtimeDirectory, "2026-08-13T04:22:00.000Z");
    const execution = claim(harness.runtime, "agent", "2026-08-13T04:22:01.000Z");
    harness.runtime.recordAgentInvocationProgress(execution.executionId, {
      schemaVersion: "AgentInvocationProgress@1",
      adapterId: "fixture-progress",
      workspace: fixture.workspace,
      workspaceAccess: "read",
      providerSessionId: "fixture-provider-session",
      startedAt: "2026-08-13T04:22:01.000Z",
      observedAt: "2026-08-13T04:22:02.000Z",
      lastMeaningfulAt: "2026-08-13T04:22:02.000Z",
      phase: "streaming",
      updateCount: 4,
      meaningfulUpdateCount: 3,
      lastProgress: { kind: "thought" },
      rawPayload: "streamed payload"
    } as AgentInvocationProgress);

    const audit = harness.runtime.audit(started.rootEventId)!;
    assert.equal(audit.invocationProgress?.providerSessionId, "fixture-provider-session");
    assert.deepEqual(audit.invocationProgress?.lastProgress, { kind: "thought" });
    assert.equal(
      (harness.runtime.executionReceiptJson(execution.executionId) ?? "")
        .includes("streamed payload"),
      false
    );
  } finally {
    harness.close();
    fixture.close();
  }
});

test("only one evidence-backed adjudication can authorize one Agent turn retry", async () => {
  const fixture = setup();
  const agent = scriptedAgent(fixture.workspace, "retry-provider", [
    new Error("provider transport failed with unknown side effects"),
    adjudicationRetry(),
    complete("retry completed")
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, agent.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "semantic-retry",
      steward: "a",
      objective: "perform one bounded turn"
    }, fixture.runtimeDirectory, "2026-08-13T04:30:00.000Z");

    await harness.agent("2026-08-13T04:30:01.000Z");
    const originalExecution = harness.runtime.executionForEvent(started.rootEventId)!;
    assert.equal(originalExecution.status, "failed");
    assert.equal(originalExecution.attemptCount, 1);
    assert.equal(originalExecution.maxAttempts, 1);
    harness.result("2026-08-13T04:30:02.000Z");
    await harness.agent("2026-08-13T04:30:03.000Z");
    harness.result("2026-08-13T04:30:04.000Z");
    await harness.agent("2026-08-13T04:30:05.000Z");
    harness.result("2026-08-13T04:30:06.000Z");

    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.terminalSummary, "retry completed");
    const requests = harness.runtime.eventsForRoot(started.rootEventId)
      .filter((event) => event.type === "agent.request");
    assert.deepEqual(requests.map((event) => event.type === "agent.request"
      ? event.runContext?.resultContractId
      : undefined), [
      "agent-turn-result@1",
      "agent-turn-adjudication@1",
      "agent-turn-retry-result@1"
    ]);
    assert.equal(requests.every((event) =>
      harness.runtime.executionForEvent(event.eventId)?.maxAttempts === 1), true);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("an explicit adjudication retry resumes the exact failed read-only provider Session", async () => {
  const fixture = setup();
  const steward = scriptedAgent(fixture.workspace, "recovery-steward", [
    delegate(fixture.agentIds.b, "perform one read-only provider turn"),
    adjudicationRetry(),
    complete("recovered child completed")
  ]);
  const worker = scriptedAgent(fixture.workspace, "recovery-worker", [
    timeoutFailure({
      adapterId: "scripted-recovery-worker",
      workspace: fixture.workspace,
      workspaceAccess: "read",
      providerSessionId: "failed-read-session"
    }),
    complete("read-only retry completed")
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, steward.adapter],
    [fixture.agentIds.b, worker.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "explicit-read-resume",
      steward: "a",
      objective: "delegate one read-only turn"
    }, fixture.runtimeDirectory, "2026-08-13T04:35:00.000Z");

    await harness.agent("2026-08-13T04:35:01.000Z");
    harness.result("2026-08-13T04:35:02.000Z");
    await harness.agent("2026-08-13T04:35:03.000Z");
    const childRequest = harness.runtime.eventsForRoot(started.rootEventId)
      .find((event) => event.type === "agent.request" && event.agentId === fixture.agentIds.b)!;
    const failureAudit = harness.runtime.audit(childRequest.eventId)!;
    assert.equal(failureAudit.resultEvent?.outcome, "failed");
    assert.equal(failureAudit.invocationFailure?.reason, "deadline");
    assert.equal(failureAudit.invocationFailure?.providerSessionId, "failed-read-session");
    assert.equal(failureAudit.invocationFailure?.lastProgress?.kind, "tool");
    assert.equal(JSON.stringify(failureAudit.invocationFailure).includes("raw tool payload"), false);

    harness.result("2026-08-13T04:35:04.000Z");
    const adjudicationRequest = harness.runtime.eventsForRoot(started.rootEventId)
      .find((event) => event.type === "agent.request" &&
        event.runContext?.resultContractId === "agent-turn-adjudication@1");
    const adjudicationPrompt = adjudicationRequest?.type === "agent.request"
      ? adjudicationRequest.prompt
      : "";
    assert.match(adjudicationPrompt, /"reason": "deadline"/u);
    assert.match(adjudicationPrompt, /"recovery": "explicit_read_only_resume"/u);
    assert.equal(adjudicationPrompt.includes("raw tool payload"), false);
    await harness.agent("2026-08-13T04:35:05.000Z");
    harness.result("2026-08-13T04:35:06.000Z");
    await harness.agent("2026-08-13T04:35:07.000Z");
    harness.result("2026-08-13T04:35:08.000Z");
    await harness.agent("2026-08-13T04:35:09.000Z");
    harness.result("2026-08-13T04:35:10.000Z");

    assert.equal(harness.runs.requireProjection(started.run.runId).status, "succeeded");
    assert.deepEqual(worker.providerSessions, [undefined, "failed-read-session"]);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("a timed-out write turn remains unknown outcome and cannot be replayed", async () => {
  const fixture = setup();
  execFileSync("git", ["init", fixture.workspace]);
  execFileSync("git", ["-C", fixture.workspace, "-c", "user.name=Test", "-c",
    "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture"]);
  const steward = scriptedAgent(fixture.workspace, "write-steward", [
    delegate(fixture.agentIds.b, "perform one write-capable provider turn"),
    adjudicationRetry()
  ]);
  const worker = scriptedAgent(fixture.workspace, "write-worker", [
    timeoutFailure({
      adapterId: "scripted-write-worker",
      workspace: fixture.workspace,
      workspaceAccess: "write",
      providerSessionId: "failed-write-session"
    }),
    complete("must never replay")
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, steward.adapter],
    [fixture.agentIds.b, worker.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "write-timeout-no-replay",
      steward: "a",
      objective: "delegate one write-capable turn",
      workspace: {
        root: fixture.workspace,
        access: "write",
        effect: "may_remain_unchanged"
      }
    }, fixture.runtimeDirectory, "2026-08-13T04:36:00.000Z");

    await harness.agent("2026-08-13T04:36:01.000Z");
    harness.result("2026-08-13T04:36:02.000Z");
    await harness.agent("2026-08-13T04:36:03.000Z");
    harness.result("2026-08-13T04:36:04.000Z");
    await harness.agent("2026-08-13T04:36:05.000Z");
    harness.result("2026-08-13T04:36:06.000Z");

    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "needs_human");
    assert.match(run.terminalSummary ?? "", /unknown outcome.*cannot be replayed/);
    assert.deepEqual(worker.providerSessions, [undefined]);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("an invalid adjudication stops at needs_human without recursive recovery", async () => {
  const fixture = setup();
  const agent = scriptedAgent(fixture.workspace, "invalid-adjudication", [
    "invalid turn result",
    "invalid adjudication"
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, agent.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "invalid-adjudication",
      steward: "a",
      objective: "perform one bounded turn"
    }, fixture.runtimeDirectory, "2026-08-13T04:40:00.000Z");
    await harness.agent("2026-08-13T04:40:01.000Z");
    harness.result("2026-08-13T04:40:02.000Z");
    await harness.agent("2026-08-13T04:40:03.000Z");
    harness.result("2026-08-13T04:40:04.000Z");

    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "needs_human");
    assert.match(run.terminalSummary ?? "", /adjudication failed/);
    assert.equal(harness.runtime.eventsForRoot(started.rootEventId)
      .filter((event) => event.type === "agent.request").length, 2);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("must_change accepts success only after Runtime observes a workspace revision", async () => {
  const fixture = setup();
  execFileSync("git", ["init", fixture.workspace]);
  execFileSync("git", ["-C", fixture.workspace, "-c", "user.name=Test", "-c",
    "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture"]);
  const agent = scriptedAgent(fixture.workspace, "observed-effect", [complete("changed")]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, agent.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "observed-effect",
      steward: "a",
      objective: "make one change",
      workspace: {
        root: fixture.workspace,
        access: "write",
        effect: "must_change"
      }
    }, fixture.runtimeDirectory, "2026-08-13T04:45:00.000Z");
    writeFileSync(join(fixture.workspace, "effect.txt"), "changed\n");
    await harness.agent("2026-08-13T04:45:01.000Z");
    harness.result("2026-08-13T04:45:02.000Z");

    assert.equal(harness.runs.requireProjection(started.run.runId).status, "succeeded");
  } finally {
    harness.close();
    fixture.close();
  }
});

test("must_change permits one safe retry then rejects another unchanged success", async () => {
  const fixture = setup();
  execFileSync("git", ["init", fixture.workspace]);
  execFileSync("git", ["-C", fixture.workspace, "-c", "user.name=Test", "-c",
    "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture"]);
  const agent = scriptedAgent(fixture.workspace, "unchanged-effect", [
    complete("claimed change"),
    adjudicationRetry(),
    complete("claimed change again")
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, agent.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "unchanged-effect",
      steward: "a",
      objective: "make one change",
      workspace: {
        root: fixture.workspace,
        access: "write",
        effect: "must_change"
      }
    }, fixture.runtimeDirectory, "2026-08-13T04:46:00.000Z");
    await harness.agent("2026-08-13T04:46:01.000Z");
    harness.result("2026-08-13T04:46:02.000Z");
    await harness.agent("2026-08-13T04:46:03.000Z");
    harness.result("2026-08-13T04:46:04.000Z");
    await harness.agent("2026-08-13T04:46:05.000Z");
    harness.result("2026-08-13T04:46:06.000Z");

    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "needs_human");
    assert.match(run.terminalSummary ?? "", /Runtime-observed revision change/);
    assert.equal(harness.runtime.eventsForRoot(started.rootEventId)
      .filter((event) => event.type === "agent.request").length, 3);
  } finally {
    harness.close();
    fixture.close();
  }
});

test("Runtime rejects a semantic retry when write-side effects remain possible", async () => {
  const fixture = setup();
  execFileSync("git", ["init", fixture.workspace]);
  execFileSync("git", ["-C", fixture.workspace, "-c", "user.name=Test", "-c",
    "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture"]);
  const agent = scriptedAgent(fixture.workspace, "unsafe-retry", [
    "invalid turn result",
    adjudicationRetry()
  ]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, agent.adapter]
  ]));
  try {
    const started = startStewardRun(fixture.repo, {
      requestId: "unsafe-semantic-retry",
      steward: "a",
      objective: "perform one write-capable turn",
      workspace: {
        root: fixture.workspace,
        access: "write",
        effect: "must_change"
      }
    }, fixture.runtimeDirectory, "2026-08-13T04:50:00.000Z");
    writeFileSync(join(fixture.workspace, "possible-side-effect.txt"), "changed\n");
    await harness.agent("2026-08-13T04:50:01.000Z");
    harness.result("2026-08-13T04:50:02.000Z");
    await harness.agent("2026-08-13T04:50:03.000Z");
    harness.result("2026-08-13T04:50:04.000Z");

    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "needs_human");
    assert.match(run.terminalSummary ?? "", /workspace revision differs/);
    assert.equal(harness.runtime.eventsForRoot(started.rootEventId)
      .filter((event) => event.type === "agent.request").length, 2);
  } finally {
    harness.close();
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
    database,
    runtime,
    runs,
    async agent(at: string) {
      const execution = claim(runtime, "agent", at);
      await agentHandler.handle(execution, at);
    },
    result(at: string) {
      const execution = claim(runtime, "result", at);
      resultHandler.handle(execution, at);
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
  if (execution === undefined) {
    throw new Error(`No due ${handler} Execution at ${at}`);
  }
  assert.equal(executions.length, 1);
  return execution;
}

function scriptedAgent(
  workspace: string,
  providerSessionId: string,
  outputs: readonly (string | Error)[]
): {
  readonly adapter: RuntimeAgentAdapter;
  readonly providerSessions: Array<string | undefined>;
} {
  const providerSessions: Array<string | undefined> = [];
  let index = 0;
  let newSessionCount = 0;
  return {
    providerSessions,
    adapter: {
      adapterId: `scripted-${providerSessionId}`,
      workspace,
      async invoke(input) {
        providerSessions.push(input.providerSessionId);
        const body = outputs[index];
        index += 1;
        if (body === undefined) throw new Error("scripted output exhausted");
        if (body instanceof Error) throw body;
        const returnedProviderSessionId = input.providerSessionId ??
          (newSessionCount++ === 0 ? providerSessionId : `${providerSessionId}-${newSessionCount}`);
        return {
          providerSessionId: returnedProviderSessionId,
          outcome: { kind: "message", body },
          invocation: {
            schemaVersion: "AgentInvocationDiagnostics@1",
            effectivePrompt: input.event.prompt,
            startedAt: "2026-07-26T00:00:00.000Z",
            completedAt: "2026-07-26T00:00:01.000Z",
            durationMilliseconds: 1_000,
            tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            toolUsage: [{ name: "Read", count: 1 }],
            turnCount: 1
          }
        };
      }
    }
  };
}

function timeoutFailure(input: {
  readonly adapterId: string;
  readonly workspace: string;
  readonly workspaceAccess: "read" | "write";
  readonly providerSessionId: string;
}): AgentInvocationError {
  const failure = {
    schemaVersion: "AgentInvocationFailure@1",
    adapterId: input.adapterId,
    workspace: input.workspace,
    workspaceAccess: input.workspaceAccess,
    providerSessionId: input.providerSessionId,
    startedAt: "2026-08-13T04:35:03.000Z",
    observedAt: "2026-08-13T04:35:04.000Z",
    lastMeaningfulAt: "2026-08-13T04:35:03.500Z",
    phase: "cancelling",
    updateCount: 3,
    meaningfulUpdateCount: 2,
    lastProgress: { kind: "tool" },
    failedAt: "2026-08-13T04:35:04.000Z",
    reason: "deadline",
    totalTimeoutMilliseconds: 300_000,
    meaningfulOutputTimeoutMilliseconds: 120_000,
    protocolStop: "requested",
    recovery: input.workspaceAccess === "write"
      ? "unknown_outcome_no_replay"
      : "explicit_read_only_resume",
    rawPayload: "raw tool payload"
  } as AgentInvocationFailure;
  return new AgentInvocationError("agent invocation timed out", failure);
}

function delegate(targetAgentId: string, objective: string): string {
  return JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "delegate",
    targetAgentId,
    mandate: { kind: "objective", objective },
    summary: `delegate ${objective}`,
    artifactRefs: []
  });
}

function complete(summary: string): string {
  return JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "complete",
    outcome: "succeeded",
    summary,
    artifactRefs: []
  });
}

function adjudicationAccept(normalizedResult: string): string {
  return JSON.stringify({
    schemaVersion: "AgentTurnAdjudication@1",
    decision: "accept",
    rationale: "The terminal evidence contains one complete unambiguous result.",
    normalizedResult: JSON.parse(normalizedResult)
  });
}

function adjudicationRetry(): string {
  return JSON.stringify({
    schemaVersion: "AgentTurnAdjudication@1",
    decision: "retry",
    rationale: "The provider failed before any tool or external operation.",
    safeToRetryEvidence: [
      "Invocation diagnostics contain no tool usage and workspace revision is unchanged."
    ]
  });
}

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-agent-run-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-agent-run-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-07-26T00:00:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  const a = foundation.addAgent("a", "codex", "2026-07-26T00:00:00.000Z");
  const b = foundation.addAgent("b", "claude-code", "2026-07-26T00:00:00.000Z");
  const c = foundation.addAgent("c", "kimi-code", "2026-07-26T00:00:00.000Z");
  foundation.close();
  return {
    repo,
    runtimeDirectory,
    workspace: paths.workspace,
    agentIds: {
      a: a.principalId,
      b: b.principalId,
      c: c.principalId
    },
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}
