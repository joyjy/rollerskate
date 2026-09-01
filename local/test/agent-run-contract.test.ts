import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentTurnResult } from "../src/modules/steward/result-contract.js";
import {
  parseRunAuthorityEnvelope,
  parseRunIntent,
  parseStewardRunRequest,
  runIntentDigest
} from "../src/modules/steward/admission-contract.js";
import {
  parseStewardOrchestratorBindingV3,
  parseStewardRunDecisionV3
} from "../src/modules/steward/run-contract-v3.js";
import {
  parseRunSourceBinding,
  parseTriggerOccurrenceEnvelope
} from "../src/modules/steward/source-contract.js";
import { parseAgentTurnAdjudication } from
  "../src/modules/steward/result-adjudication.js";
import { workflowInvocationBudget, workflowMandateSnapshot } from
  "../src/infrastructure/resources/workflow-resource.js";
import {
  newAgentRunId,
  newAgentStepId,
  planAgentRunContinuation,
  type AgentRunProjection
} from "../src/modules/steward/state-machine.js";
import { parseAgentRunDecisionReceipt, parseCallerOrchestratorBinding } from
  "../src/modules/steward/caller-contract.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("v0.5.5 Run admission contracts fail closed and keep a stable intent digest", () => {
  const intent = {
    schemaVersion: "RunIntent@1",
    requestId: "request-1",
    objective: "Inspect the release",
    acceptance: ["Report exact evidence"],
    contextRefs: ["project:rollerskate"],
    workspaceRef: "project:rollerskate",
    desiredEffect: "read",
    terminalEvidence: ["verification receipt"]
  } as const;
  const parsed = parseRunIntent(intent);
  assert.equal(runIntentDigest(parsed), runIntentDigest(parseRunIntent({ ...intent })));
  assert.throws(() => parseRunIntent({ ...intent, workspace: "/tmp/guess" }), /unknown field/);

  const authority = parseRunAuthorityEnvelope({
    schemaVersion: "RunAuthorityEnvelope@1",
    participantAgentIds: ["prn_worker"],
    workspace: {
      root: "/workspace",
      revision: "git:abc",
      access: "read",
      networkAccess: false
    },
    destinationIds: [],
    maxSteps: 4,
    maxDepth: 0
  });
  assert.equal(authority.workspace?.access, "read");
  assert.throws(() => parseRunAuthorityEnvelope({
    ...authority,
    workspace: { ...authority.workspace, effect: "must_change" }
  }), /read workspace authority cannot declare effect/);

  const request = parseStewardRunRequest({
    schemaVersion: "StewardRunRequest@2",
    requestId: "request-1",
    idempotencyKey: "request-1",
    intentDigest: runIntentDigest(parsed),
    objective: parsed.objective,
    acceptance: parsed.acceptance,
    contextRefs: parsed.contextRefs,
    terminalEvidence: parsed.terminalEvidence,
    mandate: { kind: "objective", objective: parsed.objective },
    authority,
    admissionDigest: DIGEST,
    authoritySummary: "read-only workspace; one admitted participant"
  });
  assert.equal(request.schemaVersion, "StewardRunRequest@2");
  assert.throws(() => parseStewardRunRequest({ ...request, rawGrant: {} }), /unknown field/);
});

test("v0.5.5 source binding, occurrence and Steward decision contracts are exact-key", () => {
  const binding = parseRunSourceBinding({
    schemaVersion: "RunSourceBinding@1",
    runId: "arn_run",
    seriesKey: "series-1",
    source: {
      kind: "schedule",
      id: "sch_1",
      definitionRevision: "2"
    },
    authorityDigest: DIGEST,
    occurrencePolicy: "recurring",
    cancellationPolicy: "pause_source",
    reconcilePolicy: "source_owned"
  });
  const envelope = parseTriggerOccurrenceEnvelope({
    schemaVersion: "TriggerOccurrenceEnvelope@1",
    source: binding.source,
    occurrenceKey: "2026-08-26T09:00:00.000Z",
    sourceRevision: "2",
    observedAt: "2026-08-26T09:00:01.000Z",
    observation: { due: true },
    freshnessEvidence: ["definition revision 2 is current"],
    binding: {
      runId: binding.runId,
      seriesKey: binding.seriesKey,
      authorityDigest: binding.authorityDigest
    }
  });
  assert.equal(envelope.source.kind, "schedule");
  assert.throws(() => parseTriggerOccurrenceEnvelope({
    ...envelope,
    artifactRef: "artifact://duplicate"
  }), /exactly one/);

  const authority = {
    schemaVersion: "RunAuthorityEnvelope@1",
    participantAgentIds: ["prn_worker"],
    destinationIds: [],
    maxSteps: 4,
    maxDepth: 0
  } as const;
  const orchestrator = parseStewardOrchestratorBindingV3({
    schemaVersion: "OrchestratorBinding@3",
    mode: "caller",
    callerRef: { kind: "owner", principalId: "prn_owner" },
    orchestratorRef: { kind: "agent", agentId: "prn_steward" },
    decisionContractId: "run-decision@3",
    deliveryPolicy: "internal-with-manual-fallback",
    admissionDigest: DIGEST,
    authority
  });
  assert.equal(orchestrator.decisionContractId, "run-decision@3");
  const decision = parseStewardRunDecisionV3({
    schemaVersion: "RunDecision@3",
    action: "await_source",
    expectedRunVersion: 1,
    rationale: "wait for the admitted schedule",
    checkedAcceptance: [],
    state: {
      schemaVersion: "OrchestratorState@1",
      goal: "release",
      tasks: [],
      acceptedEvidence: [],
      unresolvedQuestions: []
    },
    awaitSource: {
      sourceKind: "schedule",
      templateId: "daily-check@1",
      parameters: { expression: "0 9 * * *" }
    }
  });
  assert.equal(decision.action, "await_source");
  assert.throws(() => parseStewardRunDecisionV3({ ...decision, command: "make" }), /unknown field/);
  const receipt = {
    schemaVersion: "AgentRunDecisionReceipt@2",
    runId: "run_receipt",
    requestId: "decision-1",
    expectedRunVersion: 1,
    resultingRunVersion: 2,
    sourceStepId: "step-1",
    action: "await_source",
    resultingRunStatus: "awaiting_source",
    sourceBinding: binding,
    acceptedAt: "2026-08-26T09:00:02.000Z"
  } as const;
  assert.equal(parseAgentRunDecisionReceipt(JSON.stringify(receipt)).action, "await_source");
  assert.throws(() => parseAgentRunDecisionReceipt(JSON.stringify({
    ...receipt,
    finishScope: "cycle"
  })), /await_source shape is inconsistent/);
});

test("historical Steward records require an explicit persisted-data reader", () => {
  const binding = JSON.stringify({
    schemaVersion: "OrchestratorBinding@2",
    mode: "caller",
    callerRef: { kind: "owner", principalId: "prn_owner" },
    orchestratorRef: { kind: "agent", agentId: "prn_steward" },
    decisionContractId: "run-decision@2",
    deliveryPolicy: "internal-with-manual-fallback"
  });
  const receipt = JSON.stringify({
    schemaVersion: "AgentRunDecisionReceipt@1",
    runId: "run_legacy",
    requestId: "decision-legacy",
    expectedRunVersion: 1,
    resultingRunVersion: 2,
    sourceStepId: "step-legacy",
    action: "finish",
    terminalStatus: "succeeded",
    acceptedAt: "2026-08-18T09:00:00.000Z"
  });

  assert.throws(
    () => parseCallerOrchestratorBinding(binding),
    /Historical spec requires an explicit persisted-data reader/
  );
  assert.equal(
    parseCallerOrchestratorBinding(binding, { allowHistorical: true }).schemaVersion,
    "OrchestratorBinding@2"
  );
  assert.throws(
    () => parseAgentRunDecisionReceipt(receipt),
    /Historical spec requires an explicit persisted-data reader/
  );
  assert.equal(
    parseAgentRunDecisionReceipt(receipt, { allowHistorical: true }).schemaVersion,
    "AgentRunDecisionReceipt@1"
  );
});

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

test("Workflow invocation budgets are explicit, bounded and optional", () => {
  assert.deepEqual(workflowInvocationBudget({
    "invocation-timeout-milliseconds": "420000"
  }), {
    schemaVersion: "AgentInvocationBudget@1",
    totalTimeoutMilliseconds: 420_000
  });
  assert.equal(workflowInvocationBudget({}), undefined);
  assert.throws(() => workflowInvocationBudget({
    "invocation-timeout-milliseconds": "1.5"
  }), /must be an integer/);
  assert.throws(() => workflowInvocationBudget({
    "invocation-timeout-milliseconds": "900001"
  }), /between 1 and 900000/);
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
