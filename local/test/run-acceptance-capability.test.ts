import { cancelStewardRun } from "../src/application/steward/control.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { addLocalAgent } from "../src/application/agent/control.js";
import { startStewardRunFromIntent, startStewardRunFromOwnerIntent } from "../src/application/steward/intent-control.js";
import { authorizeRunNetwork, runCapabilityRequest } from "../src/application/steward/capability.js";
import { StewardModule } from "../src/application/steward/module.js";
import { AgentHandler, ResultHandler, type RuntimeAgentAdapter } from "../src/core/runtime/handlers.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { parseRunDecision } from "../src/modules/steward/caller-contract.js";
import { planCallerRunDecision } from "../src/modules/steward/state-machine.js";

for (const scenario of ["owner", "preauthorized", "cancel"] as const) test(`original acceptance survives bad dispatch notes and network adjustment (${scenario})`, async () => {
  const preauthorized = scenario === "preauthorized";
  const root = mkdtempSync(join(tmpdir(), "rs-capability-test-"));
  const repo = join(root, "repo"), runtimeDirectory = join(root, "runtime");
  assert.equal(spawnSync("git", ["init", repo]).status, 0);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  assert.equal(spawnSync("git", ["-C", repo, "add", "."]).status, 0);
  assert.equal(spawnSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]).status, 0);
  const agent = addLocalAgent(repo, "codex", "codex", {runtimeDirectory});
  let database = openRuntimeDatabase(join(runtimeDirectory, "runtime.db"));
  let runtime = new RuntimeStore(database), runs = new AgentRunStore(database);
  const now = () => new Date().toISOString();
  const intent = {schemaVersion: "RunIntent@1", requestId: "network-plan", objective: "Read the current remote head and deliver a plan",
    acceptance: ["Current remote head is verified"], contextRefs: ["workitem:original"],
    dispatchNotes: "If offline, list the gap and call the report done", workspaceRef: pathToFileURL(repo).href,
    desiredEffect: "read", requestedParticipantRefs: ["agent:codex"], terminalEvidence: ["plan with current head"]};
  assert.throws(() => startStewardRunFromIntent(repo, {...intent, ownerNetworkAuthorized: true}, runtimeDirectory), /unsupported|unknown|unexpected/i);
  const started = preauthorized ? startStewardRunFromOwnerIntent(repo, intent, {authorizeNetwork: true}, runtimeDirectory)
    : startStewardRunFromIntent(repo, intent, runtimeDirectory);
  const runId = started.run.runId;
  const sourceContract = started.run.orchestratorBinding?.schemaVersion === "OrchestratorBinding@3" ? started.run.orchestratorBinding.acceptanceContract : undefined;
  const state = {schemaVersion: "OrchestratorState@1", goal: intent.objective, tasks: [], acceptedEvidence: ["Local plan prepared"], unresolvedQuestions: []};
  let calls = 0;
  const adapter: RuntimeAgentAdapter = {adapterId: "acceptance-fixture", workspace: repo, async invoke(input) {
    assert.equal(input.event.type, "agent.request");
    if (input.event.type !== "agent.request") throw new Error("wrong event");
    calls++;
    const common = {schemaVersion: "RunDecision@6", expectedRunVersion: runs.requireProjection(runId).version,
      rationale: "Use original acceptance", state, checkedAcceptance: [{id: "a1", status: "unknown", evidenceRefs: []}]};
    let decision: unknown;
    if (calls === 1) {
      assert.match(input.event.prompt, /Immutable original acceptance/);
      assert.match(input.event.prompt, /dispatch notes cannot weaken/);
      decision = {...common, action: "finish", finish: {scope: "run", outcome: "succeeded", summary: "Plan done except remote facts"}};
    } else if (calls === 2) {
      assert.match(input.event.prompt, /acceptance_incomplete/);
      assert.equal(input.event.runContext?.workspaceGrant?.networkAccess, false);
      decision = {...common, action: "request_capability", capability: {kind: "network", acceptanceIds: ["a1"], targets: ["https://git.example.test/project"], reason: "Need current remote head"}};
    } else {
      assert.equal(calls, 3);
      assert.equal(input.event.runContext?.workspaceGrant?.networkAccess, true);
      assert.ok(input.event.sessionId, "grant change resumes the original logical Session with a new turn policy");
      assert.match(input.event.prompt, /Local plan prepared/);
      decision = {...common, checkedAcceptance: [{id: "a1", status: "pass", evidenceRefs: ["fixture:remote/head/current-sha"]}],
        action: "finish", finish: {scope: "run", outcome: "succeeded", summary: "Remote verified", outputs: [{id: "plan", title: "Plan", contentType: "text/plain", value: "Current head verified"}]}};
    }
    return {providerSessionId: "run-session", outcome: {kind: "message", body: JSON.stringify(decision)}};
  }};
  async function turn() {
    const manifest = new StewardModule({runtime, runs}).manifest();
    const agents = new AgentHandler({store: runtime, adapters: new Map([[agent.principalId, adapter]]), executionGuards: manifest.executionGuards});
    const results = new ResultHandler(runtime, manifest.resultContinuations);
    const execution = runtime.claimDueExecutions(100, now()).find(e => e.handler === "agent");
    assert.ok(execution); await agents.handle(execution, now());
    const result = runtime.claimDueExecutions(100, now()).find(e => e.handler === "result");
    assert.ok(result); results.handle(result, now());
  }
  try {
    const run = runs.requireProjection(runId);
    for (const checkedAcceptance of [[], [{id: "a1", status: "pass", evidenceRefs: []}], [{id: "a1", status: "fail", evidenceRefs: ["fixture:failure"]}]]) {
      const decision = parseRunDecision({schemaVersion: "RunDecision@6", expectedRunVersion: run.version, rationale: "premature success", state,
        checkedAcceptance, action: "finish", finish: {scope: "run", outcome: "succeeded", summary: "done"}});
      assert.throws(() => planCallerRunDecision({run, decision, now: now()}), /acceptance_incomplete/);
    }
    const legacy = parseRunDecision({schemaVersion: "RunDecision@1", expectedRunVersion: run.version, rationale: "bypass", checkedAcceptance: [], action: "finish", finish: {outcome: "succeeded", summary: "done"}}, {allowHistorical: true});
    assert.throws(() => planCallerRunDecision({run, decision: legacy, now: now()}), /cannot be bypassed/);
    await turn();
    assert.notEqual(runs.requireProjection(runId).status, "succeeded");
    await turn();
    let pending = runCapabilityRequest(runs.requireProjection(runId), runs, runtime)!;
    assert.ok(pending, JSON.stringify(runtime.eventsForRoot(started.rootEventId).filter(e => e.type === "agent.result")));
    assert.equal(pending.status, preauthorized ? "granted" : "pending");
    const eventCount = runtime.eventsForRoot(started.rootEventId).length;
    database.close(); database = openRuntimeDatabase(join(runtimeDirectory, "runtime.db"));
    runtime = new RuntimeStore(database); runs = new AgentRunStore(database);
    assert.deepEqual(runCapabilityRequest(runs.requireProjection(runId), runs, runtime), pending, "request survives restart");
    if (!preauthorized) {
      assert.equal(runCapabilityRequest({...runs.requireProjection(runId), deadlineAt: "2000-01-01T00:00:00.000Z"}, runs, runtime)?.status, "expired");
      if (scenario === "cancel") {
        cancelStewardRun(repo, runId, runtimeDirectory);
        assert.equal(runCapabilityRequest(runs.requireProjection(runId), runs, runtime)?.status, "closed");
        assert.throws(() => authorizeRunNetwork(repo, runId, pending.requestEventId, pending.runVersion, runtimeDirectory), /no longer pending/);
        assert.equal(runtime.eventsForRoot(started.rootEventId).length, eventCount);
        assert.equal(runs.requireProjection(runId).workspaceGrant?.networkAccess, false);
        return;
      }
      assert.throws(() => authorizeRunNetwork(repo, runId, pending.requestEventId, pending.runVersion + 1, runtimeDirectory), /no longer pending/);
      assert.equal(runtime.eventsForRoot(started.rootEventId).length, eventCount);
      assert.equal(authorizeRunNetwork(repo, runId, pending.requestEventId, pending.runVersion, runtimeDirectory).status, "accepted");
    }
    assert.equal(authorizeRunNetwork(repo, runId, pending.requestEventId, pending.runVersion, runtimeDirectory).status, "already_applied");
    await turn();
    assert.equal(runs.requireProjection(runId).status, "succeeded", JSON.stringify(runtime.eventsForRoot(started.rootEventId).filter(e => e.type === "agent.result")));
    const binding = runs.requireProjection(runId).orchestratorBinding;
    assert.deepEqual(binding?.schemaVersion === "OrchestratorBinding@3" ? binding.acceptanceContract : undefined, sourceContract);
    assert.notEqual(binding?.schemaVersion === "OrchestratorBinding@3" ? binding.admissionDigest : undefined, started.admission.admissionDigest);
    assert.equal(calls, 3);
  } finally {database.close(); rmSync(root, {recursive: true, force: true});}
});
