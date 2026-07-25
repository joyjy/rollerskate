import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleRouter } from "@/router";
import ReviewsView from "@/views/ReviewsView.vue";
import SchedulesView from "@/views/SchedulesView.vue";

const agent = {
  principalId: "agent-1",
  handle: "operator",
  client: "codex",
  status: "active"
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("Review and Schedule views", () => {
  it("renders an application-owned Review failure reference", async () => {
    const summary = {
      rootEventId: "evt_review",
      subject: {
        ref: "/workspace/acceptance.md",
        name: "acceptance.md",
        revision: "wrk_subject"
      },
      reviewer: { ...agent, handle: "reviewer" },
      implementer: { ...agent, principalId: "agent-2", handle: "implementer" },
      phase: "terminal",
      statusReason: "Reviewer could not verify the implementation.",
      cycleIndex: 1,
      revisions: { artifact: "mrsf_1", implementation: "wrk_implementation" },
      rework: { count: 1, limit: 1 },
      findings: { open: 1, resolved: 0, total: 1 },
      terminalDecision: "blocked",
      terminalReason: "Reviewer could not verify the implementation.",
      availableActions: { recover: false },
      failure: {
        failureRef: "failure:review:evt_review",
        consoleRoute: "/console/runtime?failureRef=failure%3Areview%3Aevt_review"
      },
      updatedAt: "2026-07-25T00:00:00.000Z"
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return Response.json(String(input) === "/api/reviews"
        ? [summary]
        : {
            summary,
            artifactRef: "/workspace/acceptance.md.review.yaml",
            artifact: null,
            artifactError: null,
            workspaceRevision: null,
            workspaceRevisionError: null,
            audit: []
          });
    }));
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/reviews?reviewId=evt_review");

    const wrapper = mount(ReviewsView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("Reviewer could not verify");
    expect(wrapper.get(".failure-link").text()).toContain(
      "failure:review:evt_review"
    );
    expect(wrapper.get(".failure-link").attributes("href")).toContain(
      "/console/runtime?failureRef=failure%3Areview%3Aevt_review"
    );
    wrapper.unmount();
  });

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
        createdAt: "2026-07-25T00:00:00.000Z"
      },
      runs: [{
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
    wrapper.unmount();
  });
});
