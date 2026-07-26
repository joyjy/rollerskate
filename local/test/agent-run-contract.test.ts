import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentTurnResult } from "../src/modules/agent-run/result-contract.js";
import {
  newAgentRunId,
  newAgentStepId,
  planAgentRunContinuation,
  type AgentRunProjection
} from "../src/modules/agent-run/state-machine.js";

test("AgentTurnResult@1 parses complete and one-child delegate results", () => {
  assert.deepEqual(parseAgentTurnResult(JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "complete",
    outcome: "succeeded",
    summary: "done",
    artifactRefs: ["artifact://result"]
  })), {
    schemaVersion: "AgentTurnResult@1",
    action: "complete",
    outcome: "succeeded",
    summary: "done",
    artifactRefs: ["artifact://result"]
  });
  assert.deepEqual(parseAgentTurnResult(JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "delegate",
    targetAgentId: "prn_child",
    mandate: {
      kind: "workflow",
      workflowRef: "review@1",
      inputs: { plan: "plans/review.md" }
    },
    summary: "delegate review",
    artifactRefs: []
  })).action, "delegate");
  assert.throws(() => parseAgentTurnResult(JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "delegate",
    targetAgentId: "prn_child",
    mandate: { kind: "objective", objective: "one" },
    summary: "invalid",
    artifactRefs: [],
    callbackTarget: "prn_owner"
  })), /unknown field/);
});

test("Agent Run policy selects delegate, callback, terminal and cancellation", () => {
  const run = fixtureRun();
  const stepId = run.activeStepId!;
  const context = {
    schemaVersion: "AgentRunContext@1" as const,
    resultContractId: "agent-turn-result@1" as const,
    runId: run.runId,
    stepId,
    depth: 0
  };
  assert.deepEqual(planAgentRunContinuation({
    run,
    context,
    result: {
      schemaVersion: "AgentTurnResult@1",
      action: "delegate",
      targetAgentId: "prn_child",
      mandate: { kind: "objective", objective: "child work" },
      summary: "delegate",
      artifactRefs: []
    },
    now: "2026-07-26T00:01:00.000Z"
  }), {
    kind: "delegate",
    nextStatus: "waiting",
    nextStepCount: 2
  });
  assert.equal(planAgentRunContinuation({
    run,
    context: {
      ...context,
      completionBinding: {
        schemaVersion: "AgentCompletionBinding@1",
        callerAgentId: "prn_parent",
        callerSessionId: "ses_parent",
        callerStepId: "stp_parent",
        callerRequestEventId: "evt_parent"
      }
    },
    result: {
      schemaVersion: "AgentTurnResult@1",
      action: "complete",
      outcome: "failed",
      summary: "child failed",
      artifactRefs: []
    },
    now: "2026-07-26T00:01:00.000Z"
  }).kind, "callback");
  assert.deepEqual(planAgentRunContinuation({
    run,
    context,
    result: {
      schemaVersion: "AgentTurnResult@1",
      action: "complete",
      outcome: "needs_human",
      summary: "owner decision",
      artifactRefs: []
    },
    now: "2026-07-26T00:01:00.000Z"
  }), {
    kind: "terminal",
    status: "needs_human",
    summary: "owner decision"
  });
  assert.deepEqual(planAgentRunContinuation({
    run: { ...run, status: "cancelled" },
    context,
    result: {
      schemaVersion: "AgentTurnResult@1",
      action: "complete",
      outcome: "succeeded",
      summary: "late",
      artifactRefs: []
    },
    now: "2026-07-26T00:01:00.000Z"
  }), { kind: "ignore_cancelled" });
  assert.deepEqual(planAgentRunContinuation({
    run: { ...run, deadlineAt: "2026-07-26T00:00:30.000Z" },
    context,
    result: {
      schemaVersion: "AgentTurnResult@1",
      action: "complete",
      outcome: "succeeded",
      summary: "late success",
      artifactRefs: []
    },
    now: "2026-07-26T00:00:31.000Z"
  }), {
    kind: "terminal",
    status: "failed",
    summary: "Agent Run deadline exhausted"
  });
});

function fixtureRun(): AgentRunProjection {
  return {
    runId: newAgentRunId(),
    rootEventId: "evt_root",
    ownerRequestId: "request-1",
    ownerPrincipalId: "prn_owner",
    stewardAgentId: "prn_steward",
    mandate: {
      schemaVersion: "RunMandateSnapshot@1",
      kind: "objective",
      objective: "work",
      renderedInstruction: "work"
    },
    status: "active",
    activeStepId: newAgentStepId(),
    activeExecutionId: "exe_root",
    stepCount: 1,
    maxSteps: 10,
    maxDepth: 3,
    version: 1,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z"
  };
}
