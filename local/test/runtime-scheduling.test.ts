import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeCycle } from "../src/core/runtime/cycle.js";
import { AgentHandler, ResultHandler, type RuntimeEventHandler } from "../src/core/runtime/handlers.js";
import type { AgentRunContext } from "../src/core/runtime/model.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import { LocalFoundationStore, bootstrapLocalFoundation } from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rs-admission-test-"));
  const paths = runtimePaths(directory, directory);
  const store = new RuntimeStore(paths.database);
  bootstrapLocalFoundation(paths);
  const foundation = new LocalFoundationStore(paths.database);
  const runs = new AgentRunStore(paths.database);
  const principals = new Map<string, string>();
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const cancelled = new Set<string>();
  let available = true;
  // Queue-order assertions need distinct due timestamps, not random UUID ties.
  let enqueuedAt = Date.now() - 1_000_000;
  const agent = new AgentHandler({ store,
    executionGuards: [{ moduleId: "test", canInvoke: event => cancelled.has(event.eventId)
      ? { outcome: "skip", reason: "cancelled" } : { outcome: "allow" } }],
    adapterForAgent: (_id, workspace) => available ? { adapterId: "fake", workspace: workspace ?? directory,
      async invoke({ event, providerSessionId }) {
        started.push(event.eventId);
        await new Promise<void>(resolve => releases.set(event.eventId, resolve));
        return { providerSessionId: providerSessionId ?? event.eventId, outcome: { kind: "message", body: "ok" } };
      }
    } : undefined
  });
  const result = new ResultHandler(store, [{ resultContractId: "agent-turn-result@1",
    handleAgentResult(execution, _event, _request, at) {
      store.completeResultExecution(execution.executionId, at); return true;
    } }]);
  const handlers = new Map<string, RuntimeEventHandler>([["agent", agent], ["result", result]]);
  const cycle = () => new RuntimeCycle({ store, handlers: handlers as Map<"agent" | "result", RuntimeEventHandler>,
    deliveryHandler: { async handle() { throw new Error("unexpected delivery"); } } });
  const enqueue = (agentId: string, options: { sessionId?: string; runContext?: AgentRunContext } = {}) => {
    const context = options.runContext;
    if (context !== undefined) {
      if (!principals.has(agentId)) principals.set(agentId, foundation.addAgent(agentId, "codex").principalId);
      agentId = principals.get(agentId)!;
    }
    const receipt = store.appendEvent({ type: "agent.request", source: { kind: "cli" }, agentId, prompt: "synthetic", createdAt: new Date(enqueuedAt++).toISOString(), ...options });
    if (context !== undefined && runs.projection(context.runId) === undefined) runs.createInTransaction({
      runId: context.runId, rootEventId: receipt.event.eventId, rootExecutionId: store.executionForEvent(receipt.event.eventId)!.executionId,
      ownerRequestId: context.runId, ownerPrincipalId: "test-owner", stewardAgentId: agentId,
      mandate: { schemaVersion: "RunMandateSnapshot@1", kind: "objective", objective: "test", renderedInstruction: "test" },
      ...(context.workspaceGrant === undefined ? {} : { workspaceGrant: context.workspaceGrant }), rootStepId: context.stepId, maxSteps: 10, maxDepth: 0, createdAt: receipt.event.createdAt
    });
    return receipt.event.eventId;
  };
  return { store, started, releases, cancelled, agent, handlers, cycle, enqueue,
    suspend() { available = false; },
    async close(cycles: RuntimeCycle[]) {
      for (const release of releases.values()) release();
      await Promise.all(cycles.map(cycle => cycle.settle()));
      runs.close(); foundation.close(); store.close(); rmSync(directory, { recursive: true, force: true });
    } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const context = (run: number, root: string, access: "read" | "write"): AgentRunContext => ({
  schemaVersion: "AgentRunContext@1", resultContractId: "agent-turn-result@1",
  runId: `run_019f92c9-0000-7000-8000-${String(run).padStart(12, "0")}`,
  stepId: "stp_019f92c9-0000-7000-8000-000000000022", depth: 0,
  workspaceGrant: { schemaVersion: "ExternalWorkspaceGrant@1", root, access, revision: "test" }
});

test("admission shares durable global/per-Agent caps across cycles and leaves backlog queued", async () => {
  const f = fixture(), first = f.cycle(), second = f.cycle();
  try {
    const backlog = Array.from({ length: 100 }, () => f.enqueue("hot"));
    const b = f.enqueue("b"), c = f.enqueue("c");
    first.poll(); second.poll(); await tick();
    assert.deepEqual(new Set(f.started), new Set([backlog[0], backlog[1], b, c]));
    assert.equal(f.store.executionForEvent(backlog[2]!)?.status, "queued");
    assert.equal(first.nextWaitMilliseconds(250), 250, "blocked due work must not spin");
    const seed = f.store.executionForEvent(b)!;
    f.releases.get(b)!(); await tick();
    assert.equal(f.store.execution(seed.executionId)?.status, "succeeded");
    first.poll(); await tick();
    assert.equal(f.store.executionSchedulingSnapshot().running.filter(row => row.handler === "agent").length, 3);
  } finally { await f.close([first, second]); }
});

test("same provider Session stays queued while independent cold requests can start", async () => {
  const f = fixture(), cycle = f.cycle();
  try {
    const seed = f.enqueue("a"); cycle.poll(); await tick(); f.releases.get(seed)!(); await cycle.settle();
    const result = f.store.events().find(event => event.type === "agent.result");
    assert.ok(result?.type === "agent.result" && result.sessionId);
    const one = f.enqueue("a", { sessionId: result.sessionId });
    const two = f.enqueue("a", { sessionId: result.sessionId });
    const other = f.enqueue("b");
    cycle.poll(); await tick();
    assert.ok(f.started.includes(one) && f.started.includes(other));
    assert.ok(!f.started.includes(two));
    assert.equal(f.store.executionForEvent(two)?.status, "queued");
    f.releases.get(one)!(); f.releases.get(other)!(); await cycle.settle();
  } finally { await f.close([cycle]); }
});

test("independent Run lanes parallelize; a queued cancellation never invokes", async () => {
  const f = fixture(), cycle = f.cycle();
  try {
    const one = f.enqueue("a", { runContext: context(1, "/workspace", "read") });
    const same = f.enqueue("a", { runContext: context(1, "/workspace", "read") });
    const independent = f.enqueue("a", { runContext: context(2, "/workspace", "read") });
    cycle.poll(); await tick();
    assert.deepEqual(f.started, [one, independent]);
    f.cancelled.add(same);
    f.releases.get(one)!(); f.releases.get(independent)!(); await cycle.settle();
    await cycle.run();
    assert.ok(!f.started.includes(same));
    assert.equal(f.store.executionForEvent(same)?.status, "failed");
  } finally { await f.close([cycle]); }
});

test("writer protects nested workspace through pending Result even after adapter suspension", async () => {
  const f = fixture(), cycle = f.cycle();
  try {
    const writer = f.enqueue("a", { runContext: context(1, "/workspace", "write") });
    const reader = f.enqueue("b", { runContext: context(2, "/workspace/sub", "read") });
    const isolated = f.enqueue("c", { runContext: context(3, "/other", "read") });
    cycle.poll(); await tick();
    assert.deepEqual(f.started, [writer, isolated]);
    f.releases.get(writer)!(); f.releases.get(isolated)!(); await cycle.settle();
    assert.equal(f.store.executionForEvent(writer)?.status, "succeeded", JSON.stringify(f.store.executionForEvent(writer)));
    f.suspend();
    cycle.poll(); await tick();
    assert.equal(f.store.executionForEvent(reader)?.status, "queued", "claim sees pending Result barrier");
    cycle.poll(); await cycle.settle();
    assert.notEqual(f.store.executionForEvent(reader)?.status, "queued", "consumed Result releases workspace");
  } finally { await f.close([cycle]); }
});

test("Result reserve remains available with four providers held", async () => {
  const f = fixture(), cycle = f.cycle();
  try {
    const seed = f.enqueue("seed"); cycle.poll(); await tick(); f.releases.get(seed)!(); await cycle.settle();
    const resultId = f.store.events().find(event => event.type === "agent.result")!.eventId;
    for (let i = 0; i < 8; i++) f.enqueue(`a-${i}`);
    cycle.poll(); await tick();
    assert.equal(f.store.executionForEvent(resultId)?.status, "succeeded");
    assert.equal(f.started.length, 5);
  } finally { await f.close([cycle]); }
});

test("an older waiting writer is not overtaken by later overlapping readers", async () => {
  const f = fixture(), cycle = f.cycle();
  try {
    const reader = f.enqueue("a", { runContext: context(1, "/workspace", "read") });
    const writer = f.enqueue("b", { runContext: context(2, "/workspace", "write") });
    const laterReader = f.enqueue("c", { runContext: context(3, "/workspace/sub", "read") });
    const independent = f.enqueue("d", { runContext: context(4, "/independent", "read") });
    cycle.poll(); await tick();
    assert.deepEqual(f.started, [reader, independent]);
    f.releases.get(reader)!(); f.releases.get(independent)!(); await cycle.settle();
    cycle.poll(); await cycle.settle(); // Consume the preceding read Results.
    cycle.poll(); await tick();
    assert.ok(f.started.includes(writer));
    assert.ok(!f.started.includes(laterReader));
  } finally { await f.close([cycle]); }
});

test("Agent rotation gives an unserved Agent the next available turn", async () => {
  const f = fixture(), cycle = f.cycle();
  try {
    const queues = Array.from({ length: 5 }, (_, agent) =>
      Array.from({ length: 3 }, () => f.enqueue(`agent-${agent}`)));
    cycle.poll(); await tick();
    assert.deepEqual(f.started, queues.slice(0, 4).map(rows => rows[0]));
    for (const release of f.releases.values()) release();
    await cycle.settle(); cycle.poll(); await tick();
    assert.ok(f.started.includes(queues[4]![0]!));
  } finally { await f.close([cycle]); }
});

test("Result and Chat retain separate bounded reserves under Agent saturation", async () => {
  const { ExecutionScheduler } = await import("../src/core/runtime/scheduling.js");
  const row = (id: string, handler: "agent" | "result" | "chat") => ({
    execution: { executionId: id, eventId: id, handler, status: "queued" as const,
      attemptCount: 0, maxAttempts: 1, nextAttemptAt: "2026-09-07T00:00:00.000Z",
      createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" },
    resources: { agentId: id, lanes: [id] }
  });
  const running = Array.from({ length: 4 }, (_, i) => row(`running-${i}`, "agent"));
  const due = [...Array.from({ length: 10 }, (_, i) => row(`result-${i}`, "result")),
    ...Array.from({ length: 10 }, (_, i) => row(`chat-${i}`, "chat")), row("agent", "agent")];
  const selected = new ExecutionScheduler().select(due, running, [], 7);
  assert.deepEqual(selected.map(row => row.handler), ["result", "result", "chat"]);
});
