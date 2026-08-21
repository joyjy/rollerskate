import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentTurnResult } from "../src/modules/steward/result-contract.js";
import { parseAgentTurnAdjudication } from
  "../src/modules/steward/result-adjudication.js";
import { workflowMandateSnapshot } from
  "../src/infrastructure/resources/workflow-resource.js";
import {
  newAgentRunId,
  newAgentStepId,
  planAgentRunContinuation,
  type AgentRunProjection
} from "../src/modules/steward/state-machine.js";

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
  assert.equal(parseAgentTurnResult(JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "delegate",
    targetAgentId: "prn_child",
    mandate: {
      kind: "workflow",
      workflowRef: "review@1",
      inputs: { plan: "workspace/review-plan.md" }
    },
    summary: "delegate review",
    artifactRefs: []
  })).action, "delegate");
  const readiness = parseAgentTurnResult(JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "complete",
    outcome: "succeeded",
    summary: "MR revision is complete",
    artifactRefs: [],
    outputs: [{
      id: "result",
      title: "MR readiness",
      contentType: "application/json",
      schemaVersion: "MrReadinessResult@1",
      value: { completeness: "complete" }
    }]
  }));
  assert.equal(readiness.action, "complete");
  assert.deepEqual(readiness.action === "complete" ? readiness.outputs?.[0]?.value : undefined,
    { completeness: "complete" });
  assert.throws(() => parseAgentTurnResult(JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "delegate",
    targetAgentId: "prn_child",
    mandate: { kind: "objective", objective: "one" },
    summary: "invalid",
    artifactRefs: [],
    callbackTarget: "prn_owner"
  })), /unknown field/);
  assert.throws(() => parseAgentTurnResult(JSON.stringify({
    schemaVersion: "AgentTurnResult@1",
    action: "delegate",
    targetAgentId: "prn_child",
    mandate: { kind: "objective", objective: "one" },
    summary: "legacy workflow payload",
    artifactRefs: [],
    workflowResult: { schemaVersion: "MrReadinessResult@1" }
  })), /unknown field/);
});

test("AgentTurnResult@1 extracts one bounded JSON envelope without relaxing schema", () => {
  const result = {
    schemaVersion: "AgentTurnResult@1",
    action: "complete",
    outcome: "succeeded",
    summary: "done",
    artifactRefs: []
  } as const;
  assert.deepEqual(parseAgentTurnResult(`\`\`\`json\n${JSON.stringify(result)}\n\`\`\``), result);
  assert.deepEqual(parseAgentTurnResult(`Completed.\n${JSON.stringify(result)}\nEnd.`), result);
  assert.throws(
    () => parseAgentTurnResult(`${JSON.stringify(result)}\n${JSON.stringify(result)}`),
    /must be one JSON object/
  );
  assert.throws(
    () => parseAgentTurnResult(`prefix ${JSON.stringify({ ...result, outcome: "unknown" })}`),
    /outcome is unsupported/
  );
});

test("AgentTurnAdjudication@1 requires an explicit bounded semantic decision", () => {
  const normalizedResult = {
    schemaVersion: "AgentTurnResult@1",
    action: "complete",
    outcome: "succeeded",
    summary: "done",
    artifactRefs: []
  } as const;
  assert.equal(parseAgentTurnAdjudication(JSON.stringify({
    schemaVersion: "AgentTurnAdjudication@1",
    decision: "accept",
    rationale: "The complete result was present but wrapped.",
    normalizedResult
  })).decision, "accept");
  assert.equal(parseAgentTurnAdjudication(JSON.stringify({
    schemaVersion: "AgentTurnAdjudication@1",
    decision: "retry",
    rationale: "No work was started.",
    safeToRetryEvidence: ["Provider failed before tool use and the workspace revision is unchanged."]
  })).decision, "retry");
  assert.throws(() => parseAgentTurnAdjudication(JSON.stringify({
    schemaVersion: "AgentTurnAdjudication@1",
    decision: "retry",
    rationale: "Guessing",
    safeToRetryEvidence: []
  })), /must contain 1-10/);
});

test("mr-readiness@1 renders the bounded readiness result contract", () => {
  const mandate = workflowMandateSnapshot("mr-readiness@1", {
    mr_ref: "example/project!42",
    source_revision: "sha-1",
    title: "Add readiness triage",
    description: "Automate only the first pass",
    changes: ["local/src/application/steward/control.ts"]
  });
  assert.match(mandate.renderedInstruction, /MrReadinessResult@1/);
  assert.match(mandate.renderedInstruction, /complete.*incomplete.*uncertain/s);
  assert.match(mandate.renderedInstruction, /example\/project!42/);
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
    orchestrationMode: "autonomous",
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
