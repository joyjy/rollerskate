import { resolveStewardRunPush } from "../src/application/steward/result-destination.js";
import { CodexDesktopDestinationAdapter } from "../src/integrations/codex-desktop/push.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startStewardRunFromIntent } from "../src/application/steward/intent-control.js";
import { cancelStewardRun } from "../src/application/steward/control.js";
import { compileRunIntent } from "../src/application/steward/admission.js";
import { StewardModule } from "../src/application/steward/module.js";
import { graphState } from "../src/application/steward/graph.js";
import { AgentHandler, ResultHandler, type RuntimeAgentAdapter } from "../src/core/runtime/handlers.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import { bootstrapLocalFoundation, LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

const at = (n = 0) => new Date(Date.parse("2026-09-24T00:00:00Z") + n * 1000).toISOString();
function setup(t: test.TestContext, maxConcurrency = 2) {
  const repo = mkdtempSync(join(tmpdir(), "rs-graph-execution-"));
  t.after(() => rmSync(repo, {recursive: true, force: true}));
  const directory = join(repo, "runtime");
  mkdirSync(directory);
  const paths = runtimePaths(repo, directory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, at());
  const foundation = new LocalFoundationStore(paths.database);
  const lead = foundation.addAgent("codex", "codex", at());
  const worker = foundation.addAgent("kimi", "kimi-code", at());
  foundation.close();
  const intent = {schemaVersion: "RunIntent@1", requestId: "dag-test", objective: "join two independent facts",
    acceptance: ["both facts verified"], contextRefs: [], terminalEvidence: ["joined report"], stewardRef: "agent:codex",
    graph: {schemaVersion: "RunGraph@1", participants: {worker: "agent:kimi"}, limits: {maxConcurrency, maxNodeAttempts: 1, timeoutSeconds: 300}, resultNode: "C",
      nodes: ["A", "B", "C"].map(id => ({id, executor: "worker", objective: `work-${id}`, needs: id === "C" ? ["A", "B"] : [], contextRefs: [], acceptance: [`verify ${id}`], output: {name: `report${id}`, format: "text"}}))}};
  const opened: Array<ReturnType<typeof open>> = [];
  function open(fail = false) {
    const db = openRuntimeDatabase(paths.database);
    const runtime = new RuntimeStore(db);
    const runs = new AgentRunStore(db);
    const manifest = new StewardModule({runs, runtime}).manifest();
    const calls: Array<{prompt: string; session?: string}> = [];
    let counter = 0;
    const adapter: RuntimeAgentAdapter = {adapterId: "graph-test", workspace: paths.workspace, async invoke(input) {
      calls.push({prompt: input.event.prompt, ...(input.providerSessionId === undefined ? {} : {session: input.providerSessionId})});
      if (input.event.type !== "agent.request") throw new Error("expected Agent request");
      const run = runs.requireProjection(input.event.runContext!.runId);
      const id = input.event.prompt.match(/Fixed DAG node ([ABC]):/)?.[1];
      const body = id === undefined ? {schemaVersion: "RunDecision@6", expectedRunVersion: run.version, action: "finish", rationale: "checked",
        checkedAcceptance: [{id: "a1", status: fail ? "fail" : "pass", evidenceRefs: ["worker-result"]}],
        state: {schemaVersion: "OrchestratorState@1", goal: "join facts", tasks: [], acceptedEvidence: [], unresolvedQuestions: []},
        finish: {scope: "run", outcome: fail ? "failed" : "succeeded", summary: "verified graph", outputs: [{id: "report", title: "Report", contentType: "text/plain", value: "joined"}]}}
        : {schemaVersion: "AgentStepResult@1", outcome: fail && id === "A" ? "failed" : "succeeded", summary: `fact-${id}`, artifactRefs: [`artifact-${id}`]};
      return {providerSessionId: `provider-${Date.now()}-${++counter}`, outcome: {kind: "message", body: JSON.stringify(body)}};
    }};
    const agents = new AgentHandler({store: runtime, adapters: new Map([[lead.principalId, adapter], [worker.principalId, adapter]]), executionGuards: manifest.executionGuards});
    const results = new ResultHandler(runtime, manifest.resultContinuations);
    let closed = false;
    return {runtime, runs, agents, results, calls, close() {if (!closed) {db.close(); closed = true;}}};
  }
  function harness(fail = false) {const h = open(fail); opened.push(h); return h;}
  t.after(() => opened.forEach(h => h.close()));
  return {repo, directory, intent, harness, start() {return startStewardRunFromIntent(repo, intent, directory, at());}};
}

test("DAG runs independent nodes concurrently, resumes join after restart and retains final acceptance", async t => {
  const f = setup(t);
  let h = f.harness();
  const unsupported = h.runtime.putDestination({kind: "macos-notification", address: {title: "unsupported"}, at: at()});
  const registeredUnsupported = h.runtime.enqueueHostDelivery({originId: "register-unsupported", destinationId: unsupported.destinationId,
    kind: unsupported.kind, address: unsupported.address, payload: {body: "fixture"}, at: at()});
  h.runtime.claimDueDeliveries(1, at());
  h.runtime.deliverySucceeded(registeredUnsupported.deliveryId, "fixture", at());
  assert.throws(() => compileRunIntent(f.repo, {...f.intent, resultDestinationRef: `destination:${unsupported.destinationId}`}, f.directory), /unsupported/);
  const destination = h.runtime.putDestination({kind: "codex-desktop", address: {threadId: "01a13915-bb1c-7c51-bfd8-ed88bb2ccd67"}, at: at()});
  const registeredDesktop = h.runtime.enqueueHostDelivery({originId: "register-desktop", destinationId: destination.destinationId,
    kind: destination.kind, address: destination.address, payload: {body: "fixture"}, at: at()});
  h.runtime.claimDueDeliveries(1, at());
  h.runtime.deliverySucceeded(registeredDesktop.deliveryId, "fixture", at());
  const intent = {...f.intent, resultDestinationRef: `destination:${destination.destinationId}`};
  const started = startStewardRunFromIntent(f.repo, intent, f.directory, at());
  const runId = started.run.runId;
  assert.equal(started.run.stepCount, 2);
  assert.equal(startStewardRunFromIntent(f.repo, intent, f.directory, at()).status, "duplicate");
  const first = h.runtime.claimDueExecutions(20, at(1));
  assert.equal(first.length, 2);
  assert.ok(first.every(e => e.handler === "agent"));
  const lanes = first.map(e => h.agents.resources(h.runtime.event(e.eventId)!).lanes);
  assert.equal(lanes[0]!.some(lane => lanes[1]!.includes(lane)), false);
  assert.equal((h.runtime.event(first[0]!.eventId) as import("../src/core/event/model.js").AgentRequestEvent).runContext?.invocationBudget?.totalTimeoutMilliseconds, 300_000);
  // Both Agent invocations can be in flight, even on the same Agent identity.
  await Promise.all(first.map(e => h.agents.handle(e, at(1))));
  assert.deepEqual(h.calls.map(c => c.session), [undefined, undefined]);
  const results = h.runtime.claimDueExecutions(20, at(2));
  assert.equal(results.length, 2);
  h.results.handle(results[0]!, at(2));
  assert.equal(h.runtime.claimDueExecutions(20, at(2)).length, 0);
  h.close();
  h = f.harness();
  // The second collector was interrupted; normal recovery retries collectors.
  h.runtime.reconcileInterrupted(at(3));
  const retry = h.runtime.claimDueExecutions(20, at(4));
  assert.equal(retry.length, 1);
  h.results.handle(retry[0]!, at(4));
  const join = h.runtime.claimDueExecutions(20, at(5));
  assert.equal(join.length, 1);
  const request = h.runtime.event(join[0]!.eventId)!;
  assert.equal(request.type, "agent.request");
  if (request.type !== "agent.request") throw new Error("not request");
  assert.match(request.prompt, /fact-A/); assert.match(request.prompt, /fact-B/);
  assert.equal(request.sessionId, undefined);
  await h.agents.handle(join[0]!, at(5));
  h.results.handle(h.runtime.claimDueExecutions(20, at(6))[0]!, at(6));
  assert.equal(h.runs.requireProjection(runId).status, "awaiting_orchestrator");
  await h.agents.handle(h.runtime.claimDueExecutions(20, at(7))[0]!, at(7));
  h.results.handle(h.runtime.claimDueExecutions(20, at(8))[0]!, at(8));
  assert.equal(h.runs.requireProjection(runId).status, "succeeded");
  assert.deepEqual(graphState(h.runs.requireProjection(runId), h.runs, h.runtime).map(s => s.status), ["succeeded", "succeeded", "succeeded"]);
  assert.equal(h.runs.requireProjection(runId).stepCount, 3);
  const delivery = h.runtime.claimDueDeliveries(1, at(9))[0]!;
  assert.equal(delivery.maxAttempts, 1);
  const target = h.runtime.destination(delivery.destinationId)!;
  let received = "";
  const push = new CodexDesktopDestinationAdapter(input => resolveStewardRunPush(h.runs, input), async (threadId, message) => {
    assert.equal(threadId, destination.address.threadId);
    received = message;
    return JSON.stringify({schema: "CodexPushReceipt@1", status: "accepted", threadId,
      turnId: "test-turn", ownerClientId: "test-owner", messageId: "test-message"});
  });
  const receipt = await push.deliver({delivery, destination: target});
  h.runtime.deliverySucceeded(delivery.deliveryId, receipt.receipt, at(10));
  assert.match(received, /verified graph/);
  assert.equal(JSON.parse(receipt.receipt).source.runId, runId);
  assert.throws(() => resolveStewardRunPush(h.runs, {delivery: {...delivery, payload: {body: "forged"}}, destination: target}), /immutable Run binding/);

});

test("DAG failure blocks descendants and retains final failed acceptance", async t => {
  const f = setup(t); const h = f.harness(true); const runId = f.start().run.runId;
  await Promise.all(h.runtime.claimDueExecutions(20, at(1)).map(e => h.agents.handle(e, at(1))));
  for (const e of h.runtime.claimDueExecutions(20, at(2))) h.results.handle(e, at(2));
  const state = graphState(h.runs.requireProjection(runId), h.runs, h.runtime);
  assert.deepEqual(state.map(s => s.status), ["failed", "succeeded", "blocked"], JSON.stringify(state));
  assert.equal(h.runs.requireProjection(runId).checkpoint?.result.outcome, "failed");
  await h.agents.handle(h.runtime.claimDueExecutions(20, at(3))[0]!, at(3));
  h.results.handle(h.runtime.claimDueExecutions(20, at(4))[0]!, at(4));
  assert.equal(h.runs.requireProjection(runId).status, "failed");
});

test("DAG cancellation ignores late results and never dispatches the join", async t => {
  const f = setup(t); const h = f.harness(); const runId = f.start().run.runId;
  await Promise.all(h.runtime.claimDueExecutions(20, at(1)).map(e => h.agents.handle(e, at(1))));
  cancelStewardRun(f.repo, runId, f.directory, at(2));
  for (const e of h.runtime.claimDueExecutions(20, at(3))) h.results.handle(e, at(3));
  assert.equal(h.runs.requireProjection(runId).status, "cancelled");
  assert.equal(h.runs.requireProjection(runId).stepCount, 2);
  assert.equal(h.runtime.claimDueExecutions(20, at(4)).length, 0);
});

test("DAG concurrency bound and interrupted Agent recovery do not replay unknown work", async t => {
  const f = setup(t, 1); const h = f.harness(); const runId = f.start().run.runId;
  assert.equal(h.runtime.claimDueExecutions(20, at(1)).length, 1);
  h.runtime.reconcileInterrupted(at(2));
  const result = h.runtime.claimDueExecutions(20, at(3));
  assert.equal(result.length, 1); assert.equal(result[0]!.handler, "result");
  h.results.handle(result[0]!, at(3));
  const next = h.runtime.claimDueExecutions(20, at(4));
  assert.equal(next.length, 1);
  assert.match((h.runtime.event(next[0]!.eventId) as {prompt: string}).prompt, /Fixed DAG node B:/);
  assert.deepEqual(graphState(h.runs.requireProjection(runId), h.runs, h.runtime).map(s => s.status), ["failed", "active", "blocked"]);
});

test("DAG admission rejects write effects, retries and unbound executors", t => {
  const f = setup(t);
  assert.throws(() => compileRunIntent(f.repo, {...f.intent, desiredEffect: "change"}, f.directory), /read-only/);
  assert.throws(() => compileRunIntent(f.repo, {...f.intent, graph: {...f.intent.graph, limits: {...f.intent.graph.limits, maxNodeAttempts: 2}}}, f.directory), /maxNodeAttempts/);
  assert.throws(() => compileRunIntent(f.repo, {...f.intent, graph: {...f.intent.graph, participants: {worker: "agent:missing"}}}, f.directory), /not active/);
});

test("DAG deadline caps the first invocation and settles all late results", async t => {
  const f = setup(t); const h = f.harness();
  const {startStewardRunFromOwnerIntent} = await import("../src/application/steward/intent-control.js");
  const started = startStewardRunFromOwnerIntent(f.repo, f.intent, {deadlineAt: at(5)}, f.directory, at());
  const root = h.runtime.event(started.rootEventId) as import("../src/core/event/model.js").AgentRequestEvent;
  assert.equal(root.runContext?.invocationBudget?.totalTimeoutMilliseconds, 5_000);
  await Promise.all(h.runtime.claimDueExecutions(20, at(1)).map(e => h.agents.handle(e, at(6))));
  for (const e of h.runtime.claimDueExecutions(20, at(7))) h.results.handle(e, at(7));
  assert.equal(h.calls.length, 0);
  assert.equal(h.runs.requireProjection(started.run.runId).status, "failed");
  assert.equal(h.runtime.claimDueExecutions(20, at(8)).length, 0);
  assert.equal(h.runs.requireProjection(started.run.runId).stepCount, 2);
});

test("v76 migration permits independent sessions without losing prior data", async t => {
  const {migrateLocalDatabase} = await import("../src/infrastructure/sqlite/schema/index.js");
  const {writeSchemaVersion} = await import("../src/infrastructure/sqlite/schema/introspection.js");
  const f = setup(t);
  const db = openRuntimeDatabase(runtimePaths(f.repo, f.directory).database);
  try {
    db.exec(`DROP INDEX agent_sessions_run_agent; DROP INDEX agent_sessions_run_cycle_agent;
      CREATE UNIQUE INDEX agent_sessions_run_agent ON agent_sessions(run_id,agent_id) WHERE run_id IS NOT NULL AND cycle_id IS NULL;
      CREATE UNIQUE INDEX agent_sessions_run_cycle_agent ON agent_sessions(run_id,cycle_id,agent_id) WHERE cycle_id IS NOT NULL;`);
    writeSchemaVersion(db, 76);
    const before = db.prepare("SELECT count(*) n FROM agents").get()?.n;
    migrateLocalDatabase(db);
    assert.equal(db.prepare("SELECT count(*) n FROM agents").get()?.n, before);
    const indices = db.prepare("PRAGMA index_list(agent_sessions)").all();
    assert.equal(indices.find(index => index.name === "agent_sessions_run_agent")?.unique, 0);
    assert.equal(indices.find(index => index.name === "agent_sessions_run_cycle_agent")?.unique, 0);
    migrateLocalDatabase(db);
  } finally {db.close();}
});


test("exhausted result processing terminalizes the Run without replaying successful Agent work", async t => {
  const f = setup(t); const h = f.harness(); const runId = f.start().run.runId;
  await Promise.all(h.runtime.claimDueExecutions(20, at(1)).map(e => h.agents.handle(e, at(1))));
  for (const execution of h.runtime.claimDueExecutions(20, at(2))) h.results.handle(execution, at(2));
  await h.agents.handle(h.runtime.claimDueExecutions(20, at(3))[0]!, at(3));
  const append = h.runtime.appendEventInTransaction.bind(h.runtime);
  h.runtime.appendEventInTransaction = input => {
    if (input.type === "agent.request" && input.runContext?.resultContractId.startsWith("run-decision@")) throw new Error("collector continuation unavailable");
    return append(input);
  };
  let failedId = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const time = at(4 + attempt * 30);
    const execution = h.runtime.claimDueExecutions(20, time)[0]!;
    failedId = execution.executionId;
    assert.throws(() => h.results.handle(execution, time), /collector continuation unavailable/);
    h.runtime.failExecution(execution.executionId, "collector continuation unavailable", time);
    assert.equal(h.runs.requireProjection(runId).status, attempt === 2 ? "failed" : "active");
  }
  assert.equal(h.runtime.execution(failedId)?.status, "failed");
  assert.match(h.runs.requireProjection(runId).terminalSummary!, /Result processing exhausted.*collector continuation unavailable/);
  assert.equal(JSON.parse(h.runtime.executionReceiptJson(failedId)!).schema, "StewardResultProcessingFailure@1");
  assert.equal(h.calls.length, 3);
  assert.equal(h.runtime.claimDueExecutions(20, at(200)).length, 0);
});
