import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleRouter } from "@/router";
import SchedulesView from "@/views/SchedulesView.vue";
import SubscriptionsView from "@/views/SubscriptionsView.vue";

const agent = {
  principalId: "agent-1",
  handle: "operator",
  client: "codex",
  status: "active"
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("Schedule view", () => {
  it("renders guarded Schedule controls and unknown reconciliation", async () => {
    const summary = {
      scheduleId: "sch_1",
      status: "active",
      statusReason: "Future occurrences are eligible for admission.",
      currentRevision: 1,
      nextRunAt: "2099-07-25T01:00:00.000Z",
      nextOccurrenceMissing: false,
      kind: "once",
      expression: "2099-07-25T01:00:00.000Z",
      timezone: null,
      sessionPolicy: "new_each_run",
      fixedSessionId: null,
      owner: agent,
      agent,
      runCounts: {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        unknown: 1
      },
      availableActions: {
        pause: true,
        resume: false,
        cancel: true,
        runNow: true
      },
      updatedAt: "2026-07-25T00:00:00.000Z"
    };
    const detail = {
      summary,
      revision: {
        revision: 1,
        misfirePolicy: "run_once",
        overlapPolicy: "queue",
        misfireGraceMilliseconds: 60_000,
        prompt: "Run fixture",
        workspace: "/workspace",
        callbacks: [],
        createdAt: "2026-07-25T00:00:00.000Z"
      },
      runs: [{
        runId: "run_done",
        scheduleId: "sch_1",
        occurrenceKey: "manual:done",
        scheduledFor: "2026-07-25T00:00:00.000Z",
        scheduleRevision: 1,
        status: "succeeded",
        statusReason: "The provider outcome completed successfully.",
        eventId: "evt_done",
        executionId: "exe_done",
        sessionId: "ses_done",
        decisionReason: "manual",
        callbacks: [],
        availableActions: {
          resolveSucceeded: false,
          resolveFailed: false
        },
        failure: null,
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:01.000Z",
        completedAt: "2026-07-25T00:00:01.000Z",
        audit: invocationAudit({
          eventId: "evt_done",
          sourceKind: "schedule",
          prompt: "Scheduled prompt",
          output: "Scheduled response"
        })
      }, {
        runId: "run_1",
        scheduleId: "sch_1",
        occurrenceKey: "manual:fixture",
        scheduledFor: "2026-07-25T00:01:00.000Z",
        scheduleRevision: 1,
        status: "unknown",
        statusReason: "provider-outcome-unknown",
        eventId: "evt_run",
        executionId: "exe_run",
        sessionId: "ses_run",
        decisionReason: "provider-outcome-unknown",
        callbacks: [{
          occurrenceId: "pcb_unknown",
          callbackId: "agent",
          ordinal: 0,
          kind: "agent.invoke",
          status: "unknown",
          phase: "unknown",
          eventId: "evt_run",
          deliveryId: null,
          receipt: { outcome: "unknown" },
          lastError: "runtime_interrupted",
          startedAt: "2026-07-25T00:01:00.000Z",
          completedAt: "2026-07-25T00:02:00.000Z",
          delivery: null
        }],
        availableActions: {
          resolveSucceeded: true,
          resolveFailed: true
        },
        failure: {
          failureRef: "failure:schedule:run_1",
          consoleRoute: "/console/runtime?failureRef=failure%3Aschedule%3Arun_1"
        },
        createdAt: "2026-07-25T00:01:00.000Z",
        updatedAt: "2026-07-25T00:02:00.000Z",
        completedAt: null,
        audit: null
      }]
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return Response.json(String(input) === "/api/schedules" ? [summary] : detail);
    }));
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/schedules?scheduleId=sch_1");

    const wrapper = mount(SchedulesView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("provider-outcome-unknown");
    expect(wrapper.findAll("button").map((button) => button.text())).toEqual(
      expect.arrayContaining([
        "Pause",
        "Run now",
        "Cancel",
        "Resolve succeeded",
        "Resolve failed"
      ])
    );
    expect(wrapper.get(".failure-link").text()).toContain(
      "failure:schedule:run_1"
    );
    expect(wrapper.text()).toContain("Scheduled response");
    expect(wrapper.get("details.raw-response").attributes()).toHaveProperty("open");
    wrapper.unmount();
  });
});

describe("Subscription view", () => {
  it("shows exact callbacks and terminal observation in the Subscription detail", async () => {
    const subscription = {
      kind: "free",
      id: "sub_1",
      title: "Pipeline completion",
      status: "completed",
      owner: { agentId: "agent-1", handle: "operator", client: "codex" },
      definition: {
        schema: "SubscriptionDefinition@3",
        revision: "pipeline-v1",
        digest: "definition-digest",
        callbackPhaseStatus: "completed",
        artifactRevision: "probe-v1",
        artifactDigest: `sha256:${"0".repeat(64)}`,
        callbacks: [{
          callbackId: "scb_1",
          kind: "agent.invoke",
          definition: { prompt: "Subscription prompt" },
          grant: { workspaceAccess: "read", networkAccess: false }
        }]
      },
      callbacks: [{
        occurrenceId: "pcb_1",
        callbackId: "scb_1",
        ordinal: 0,
        kind: "agent.invoke",
        definition: { prompt: "Subscription prompt" },
        grant: { workspaceAccess: "read", networkAccess: false },
        status: "succeeded",
        invocationStatus: "succeeded",
        agentResult: {
          schemaVersion: "SubscriptionAgentResult@1",
          status: "failed",
          summary: "Reviewer update was not completed",
          artifactRefs: []
        },
        receipt: { output: "Subscription response" }
      }],
      probe: {
        plugin: { id: "pipeline", path: "/plugin.ts", schemaVersion: 1 },
        policy: {
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      schedule: {
        intervalMilliseconds: 1_000,
        maxWaitMilliseconds: 10_000,
        maxAttempts: 10,
        attemptCount: 1,
        deadlineAt: "2026-07-25T00:01:00.000Z",
        nextPollAt: "2026-07-25T00:00:01.000Z"
      },
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:01.000Z",
      latestError: null,
      terminalObservation: { terminal: "success", facts: { pipeline: "passed" } }
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/subscriptions") return Response.json([subscription]);
      return Response.json({ error: "unexpected" }, { status: 500 });
    }));
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/subscriptions?subscriptionId=sub_1");

    const wrapper = mount(SubscriptionsView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("Registered callback grants");
    expect(wrapper.text()).toContain("Subscription prompt");
    expect(wrapper.text()).toContain("Subscription response");
    expect(wrapper.text()).toContain("pipeline");
    expect(wrapper.get(".callback-status").text()).toContain("Invocation succeeded");
    expect(wrapper.get(".callback-status").text()).toContain("Result failed");
    expect(wrapper.text()).toContain("Reviewer update was not completed");
    wrapper.unmount();
  });
});

function invocationAudit(input: {
  eventId: string;
  sourceKind: "schedule" | "subscription";
  prompt: string;
  output: string;
}) {
  const createdAt = "2026-07-25T00:00:00.000Z";
  return {
    event: {
      eventId: input.eventId,
      type: input.sourceKind === "schedule" ? "agent.request" : "subscription.fire",
      source: { kind: input.sourceKind, externalId: `${input.sourceKind}:fixture` },
      agentId: "agent-1",
      prompt: input.prompt,
      boundedPromptSummary: input.prompt,
      destinationIds: [],
      causality: { rootEventId: input.eventId, hop: 0 },
      createdAt
    },
    execution: {
      executionId: `exe_${input.eventId}`,
      handler: "agent",
      status: "succeeded",
      attemptCount: 1,
      maxAttempts: 3,
      firstStartedAt: createdAt,
      lastAttemptAt: createdAt,
      completedAt: createdAt,
      nextAttemptAt: createdAt
    },
    resultEvent: {
      eventId: `result_${input.eventId}`,
      type: "agent.result",
      outcome: "succeeded",
      output: input.output,
      causality: { rootEventId: input.eventId, parentEventId: input.eventId, hop: 1 },
      createdAt
    },
    invocation: {
      schemaVersion: "AgentInvocationDiagnostics@1",
      effectivePrompt: input.prompt,
      startedAt: createdAt,
      completedAt: createdAt,
      durationMilliseconds: 100,
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      toolUsage: [],
      turnCount: 1
    },
    deliveries: [],
    lifecycleChangedAt: createdAt,
    reasonForIntervention: null,
    directChildren: [],
    causalityBoundary: null
  };
}
