import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentWorkRequest,
  AgentWorkRequestDecision,
  AgentWorkRequestResultSubmit,
  AgentWorkRequestRunAttach
} from "../src/protocol.js";
import {
  decideWorkRequestForTarget,
  type WorkRequestTarget
} from "../src/application/work-request/control.js";
import { AgentWorkRequestRuntime } from
  "../src/application/work-request/runtime.js";
import { cancelStewardRun } from "../src/application/steward/control.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

const AT = "2026-08-13T12:00:00.000Z";

test("owner decisions are fixed, idempotent and create a Run only after acceptance", async () => {
  const fixture = setup();
  try {
    const server = new FakeWorkRequestClient([
      request("decision", { requestedBudget: { maxSteps: 100, maxDepth: 20 } }),
      request("rejected")
    ]);
    const target = fixture.target(server);
    const awaiting = await decideWorkRequestForTarget(fixture.repo, {
      agentHandle: "worker",
      workRequestId: "decision",
      expectedRevision: 1,
      decision: "awaiting-owner"
    }, target, fixture.dependencies);
    assert.equal(awaiting.request.status, "awaiting-owner");
    assert.equal(fixture.runs().length, 0);

    const accepted = await decideWorkRequestForTarget(fixture.repo, {
      agentHandle: "worker",
      workRequestId: "decision",
      expectedRevision: 2,
      decision: "accepted"
    }, target, fixture.dependencies);
    assert.equal(accepted.request.status, "accepted");
    assert.deepEqual(accepted.request.decisionReceipt?.admittedBudget, {
      maxSteps: 20,
      maxDepth: 4
    });
    assert.deepEqual(accepted.request.decisionReceipt?.admittedGrantRefs, []);
    assert.ok(accepted.run !== undefined);
    const duplicate = await decideWorkRequestForTarget(fixture.repo, {
      agentHandle: "worker",
      workRequestId: "decision",
      expectedRevision: 2,
      decision: "accepted"
    }, target, fixture.dependencies);
    assert.equal(duplicate.run?.status, "duplicate");
    assert.equal(duplicate.run?.run.runId, accepted.run.run.runId);
    assert.equal(fixture.runs().length, 1);

    const rejected = await decideWorkRequestForTarget(fixture.repo, {
      agentHandle: "worker",
      workRequestId: "rejected",
      expectedRevision: 1,
      decision: "rejected"
    }, target, fixture.dependencies);
    assert.equal(rejected.request.status, "rejected");
    assert.equal(fixture.runs().length, 1);
  } finally {
    fixture.close();
  }
});

test("route restart does not redeliver unaccepted work and recovers accepted Run receipts", async () => {
  const fixture = setup();
  try {
    const old = request("old-route");
    const accepted = acceptedRequest("accepted-before-restart");
    const server = new FakeWorkRequestClient([old, accepted]);
    server.bind("old-route", "route-old");
    const target = fixture.target(server);
    const first = new AgentWorkRequestRuntime({
      repoRoot: fixture.repo,
      targets: [target],
      routeId: "route-old",
      dependencies: fixture.dependencies
    });
    const firstCycle = await first.runCycle();
    assert.deepEqual(firstCycle.routed, ["old-route"]);
    assert.deepEqual(firstCycle.recovered, ["accepted-before-restart"]);
    assert.equal(fixture.runs().length, 1);

    const restarted = new AgentWorkRequestRuntime({
      repoRoot: fixture.repo,
      targets: [target],
      routeId: "route-new",
      dependencies: fixture.dependencies
    });
    const restartCycle = await restarted.runCycle();
    assert.deepEqual(restartCycle.routed, []);
    assert.deepEqual(restartCycle.recovered, []);
    assert.equal(server.value("old-route").status, "received");

    const run = fixture.runs()[0]!;
    cancelStewardRun(fixture.repo, run.runId, fixture.runtimeDirectory, AT);
    const completed = await restarted.runCycle();
    assert.deepEqual(completed.completed, ["accepted-before-restart"]);
    assert.equal(server.value("accepted-before-restart").result?.outcome, "cancelled");
    const readsAfterCompletion = server.workRequestReads;
    assert.deepEqual((await restarted.runCycle()).completed, []);
    assert.equal(server.workRequestReads, readsAfterCompletion);
  } finally {
    fixture.close();
  }
});

class FakeWorkRequestClient {
  public workRequestReads = 0;
  readonly #requests = new Map<string, AgentWorkRequest>();
  readonly #routes = new Map<string, string>();

  public constructor(requests: readonly AgentWorkRequest[]) {
    for (const item of requests) this.#requests.set(item.workRequestId, item);
  }

  public bind(workRequestId: string, routeId: string): void {
    this.#routes.set(workRequestId, routeId);
  }

  public value(workRequestId: string): AgentWorkRequest {
    const value = this.#requests.get(workRequestId);
    if (value === undefined) throw new Error("missing fake request");
    return value;
  }

  public async registerWorkRequestRoute(routeId: string) {
    return {
      schemaVersion: "WorkRequestRouteReceipt@1" as const,
      routeId,
      agentId: "server-worker",
      expiresAt: "2026-08-13T12:01:00.000Z"
    };
  }

  public async routedWorkRequests(routeId: string): Promise<readonly AgentWorkRequest[]> {
    return [...this.#requests.values()].filter((item) =>
      (item.status === "received" || item.status === "awaiting-owner") &&
      this.#routes.get(item.workRequestId) === routeId);
  }

  public async acceptedWorkRequestsWithoutRun(): Promise<readonly AgentWorkRequest[]> {
    return [...this.#requests.values()].filter((item) =>
      item.status === "accepted" && item.runReceipt === undefined);
  }

  public async workRequest(workRequestId: string): Promise<AgentWorkRequest> {
    this.workRequestReads += 1;
    return this.value(workRequestId);
  }

  public async decideWorkRequest(
    workRequestId: string,
    input: AgentWorkRequestDecision
  ): Promise<AgentWorkRequest> {
    const current = this.value(workRequestId);
    if (current.decisionReceipt !== undefined &&
      JSON.stringify(current.decisionReceipt) === JSON.stringify(input.receipt)) return current;
    assert.equal(input.expectedRevision, current.revision);
    return this.#update(workRequestId, {
      status: input.receipt.decision,
      statusReason: input.receipt.statusReason,
      decisionReceipt: input.receipt
    });
  }

  public async attachWorkRequestRun(
    workRequestId: string,
    input: AgentWorkRequestRunAttach
  ): Promise<AgentWorkRequest> {
    const current = this.value(workRequestId);
    if (current.runReceipt !== undefined) {
      assert.equal(current.runReceipt.runId, input.receipt.runId);
      return current;
    }
    assert.equal(input.expectedRevision, current.revision);
    return this.#update(workRequestId, { runReceipt: input.receipt });
  }

  public async completeWorkRequest(
    workRequestId: string,
    input: AgentWorkRequestResultSubmit
  ): Promise<AgentWorkRequest> {
    const current = this.value(workRequestId);
    if (current.result !== undefined) return current;
    assert.equal(input.expectedRevision, current.revision);
    return this.#update(workRequestId, {
      status: "completed",
      statusReason: input.result.outcome,
      result: input.result
    });
  }

  #update(workRequestId: string, patch: Partial<AgentWorkRequest>): AgentWorkRequest {
    const current = this.value(workRequestId);
    const next = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: AT
    } as AgentWorkRequest;
    this.#requests.set(workRequestId, next);
    return next;
  }
}

function request(
  workRequestId: string,
  overrides: Partial<AgentWorkRequest> = {}
): AgentWorkRequest {
  return {
    schemaVersion: "AgentWorkRequest@1",
    workRequestId,
    requestId: `request-${workRequestId}`,
    requesterRef: { kind: "human", id: "requester" },
    targetAgentRef: { kind: "agent", id: "server-worker" },
    objective: "Perform bounded work",
    contextRefs: [],
    workflowRef: "forum@1",
    requestedBudget: { maxSteps: 4, maxDepth: 1 },
    requestedGrantRefs: ["unavailable-local-grant"],
    resultRoute: "requester-bounded@1",
    expiresAt: "2026-08-13T13:00:00.000Z",
    status: "received",
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  };
}

function acceptedRequest(workRequestId: string): AgentWorkRequest {
  return request(workRequestId, {
    status: "accepted",
    revision: 2,
    statusReason: "owner-explicit-acceptance",
    decisionReceipt: {
      schemaVersion: "AgentWorkRequestDecisionReceipt@1",
      decision: "accepted",
      policyRevision: 1,
      statusReason: "owner-explicit-acceptance",
      admittedWorkflowRef: "forum@1",
      admittedBudget: { maxSteps: 4, maxDepth: 1 },
      admittedGrantRefs: [],
      decidedAt: AT
    }
  });
}

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-work-request-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-work-request-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, AT);
  const foundation = new LocalFoundationStore(paths.database);
  const agent = foundation.addAgent("worker", "codex", AT);
  foundation.close();
  const dependencies = { runtimeDirectory, now: () => new Date(AT) };
  return {
    repo,
    runtimeDirectory,
    dependencies,
    target(client: FakeWorkRequestClient): WorkRequestTarget {
      return {
        serverAgentId: "server-worker",
        localAgentId: agent.principalId,
        handle: "worker",
        client
      };
    },
    runs() {
      const store = new AgentRunStore(paths.database);
      try {
        return store.list();
      } finally {
        store.close();
      }
    },
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}
