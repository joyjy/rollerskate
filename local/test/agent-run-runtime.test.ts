import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cancelAgentRun,
  startAgentRun
} from "../src/application/agent-run/control.js";
import { AgentRunModule } from "../src/application/agent-run/module.js";
import { inspectAgentRunView } from "../src/application/agent-run/query.js";
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
    const started = startAgentRun(fixture.repo, {
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

    const view = inspectAgentRunView(
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
    const started = startAgentRun(fixture.repo, {
      requestId: "cancel-running",
      steward: "a",
      objective: "wait"
    }, fixture.runtimeDirectory, "2026-07-26T01:00:00.000Z");
    const handling = harness.agent("2026-07-26T01:00:01.000Z");
    await invokedPromise;
    const cancelled = cancelAgentRun(
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
  const agent = scriptedAgent(fixture.workspace, "opaque-provider", [malformedOutput]);
  const harness = runtimeHarness(fixture, new Map([
    [fixture.agentIds.a, agent.adapter]
  ]));
  try {
    const started = startAgentRun(fixture.repo, {
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
    assert.equal(JSON.parse(receipt.receipt_json).outcome, "invalid_result");
    const run = harness.runs.requireProjection(started.run.runId);
    assert.equal(run.status, "failed");
    assert.equal(
      run.terminalSummary,
      "AgentTurnResult@1 output must be one JSON object"
    );
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
  const module = new AgentRunModule({ runs, runtime });
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
      adapterId: `scripted-${providerSessionId}`,
      workspace,
      async invoke(input) {
        providerSessions.push(input.providerSessionId);
        const body = outputs[index];
        index += 1;
        if (body === undefined) throw new Error("scripted output exhausted");
        return {
          providerSessionId,
          outcome: { kind: "message", body }
        };
      }
    }
  };
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
