import { mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { describe, expect, it } from "vitest";

import type { AgentRunDetailViewOutput, AgentRunStepOutput } from "@/api/schema";
import AgentInvocationDetail from "@/components/AgentInvocationDetail.vue";
import AgentRunOverview from "@/components/AgentRunOverview.vue";
import { createConsoleRouter } from "@/router";

describe("AgentRunOverview", () => {
  it("shows generic Run progress, links to the Event trace and exposes cancel", async () => {
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const wrapper = mount(AgentRunOverview, {
      global: { plugins: [router] },
      props: {
        run: {
          summary: {
            runId: "run_1",
            rootEventId: "evt_root",
            series: null,
            orchestrationMode: "autonomous",
            mandate: {
              kind: "workflow",
              label: "review@1",
              workflowRef: "review@1"
            },
            steward: agent("steward"),
            workspace: {
              root: "/workspace",
              access: "write",
              admittedRevision: "wrk_initial"
            },
            progress: { steps: 3, maxSteps: 8, maxDepth: 3 },
            status: "waiting",
            terminalSummary: null,
            updatedAt: "2026-07-25T00:00:00.000Z"
          },
          projection: {
            runId: "run_1",
            status: "waiting",
            orchestrationMode: "autonomous",
            activeStepId: "stp_1",
            stepCount: 3,
            maxSteps: 8,
            maxDepth: 3
          },
          cycles: [],
          checkpoint: null,
          decisions: [],
          participants: [agent("steward"), agent("reviewer")],
          sessions: [],
          exchanges: [],
          exchangeCounts: [{
            fromAgentId: "agent-steward",
            toAgentId: "agent-reviewer",
            delegates: 1,
            callbacks: 1,
            total: 2
          }],
          steps: [],
          outputFolders: [],
          timeline: [],
          currentWorkspaceRevision: null,
          workspaceRevisionError: null,
        }
      }
    });

    expect(wrapper.text()).toContain("review@1");
    expect(wrapper.text()).toContain("@steward");
    expect(wrapper.text()).toContain("3/8 turns");
    expect(wrapper.text()).toContain("2 Agent exchanges");
    expect(wrapper.get(".trace-link").attributes("href")).toContain(
      "/console/events?eventId=evt_root"
    );
    await wrapper.get(".cancel-button").trigger("click");
    expect(wrapper.emitted("cancel")).toEqual([["run_1"]]);
  });

  it("renders ordered compact AgentInvocationDetail steps with depth indentation", async () => {
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const steps: AgentRunStepOutput[] = [
      step({ stepId: "stp_1", depth: 0, status: "succeeded", prompt: "first prompt" }),
      step({ stepId: "stp_2", depth: 1, status: "running", prompt: "nested prompt" })
    ];
    const wrapper = mount(AgentRunOverview, {
      global: { plugins: [router] },
      props: {
        run: baseRun({ steps })
      }
    });

    const details = wrapper.findAllComponents(AgentInvocationDetail);
    expect(details).toHaveLength(2);
    expect(details[0]!.props("status")).toBe("succeeded");
    expect(details[0]!.props("prompt")).toBe("first prompt");
    expect(details[1]!.props("status")).toBe("running");
    expect(details[1]!.props("prompt")).toBe("nested prompt");

    const items = wrapper.findAll(".step-item");
    expect(items[0]!.attributes("style")).toContain("padding-left: 0px");
    expect(items[1]!.attributes("style")).toContain("padding-left: 16px");
  });

  it("shows empty state when no steps are present", async () => {
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const wrapper = mount(AgentRunOverview, {
      global: { plugins: [router] },
      props: { run: baseRun({ steps: [] }) }
    });
    expect(wrapper.text()).toContain("No steps recorded.");
    expect(wrapper.findAllComponents(AgentInvocationDetail)).toHaveLength(0);
  });

  it("shows a typed Caller checkpoint instead of treating the Run as terminal", async () => {
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/steward");
    const base = baseRun();
    const run: AgentRunDetailViewOutput = {
      ...base,
      summary: {
        ...base.summary,
        status: "awaiting_orchestrator",
        orchestrationMode: "caller"
      },
      projection: {
        ...base.projection,
        status: "awaiting_orchestrator",
        orchestrationMode: "caller"
      },
      checkpoint: {
        schemaVersion: "AgentRunCheckpoint@1",
        stepId: "stp_1",
        agentId: "agent-steward",
        requestEventId: "evt_request",
        resultEventId: "evt_result",
        executionId: "exe_1",
        result: {
          schemaVersion: "AgentStepResult@1",
          outcome: "succeeded",
          summary: "audit complete",
          artifactRefs: []
        },
        recordedAt: "2026-08-18T00:00:00.000Z"
      }
    };
    const wrapper = mount(AgentRunOverview, {
      global: { plugins: [router] },
      props: { run }
    });

    expect(wrapper.text()).toContain("Awaiting Caller decision");
    expect(wrapper.text()).toContain("succeeded · audit complete");
  });
});

function baseRun(overrides: { steps?: AgentRunStepOutput[] } = {}): AgentRunDetailViewOutput {
  return {
    summary: {
      runId: "run_1",
      rootEventId: "evt_root",
      series: null,
      orchestrationMode: "autonomous",
      mandate: {
        kind: "workflow",
        label: "review@1",
        workflowRef: "review@1"
      },
      steward: agent("steward"),
      workspace: {
        root: "/workspace",
        access: "write",
        admittedRevision: "wrk_initial"
      },
      progress: { steps: 3, maxSteps: 8, maxDepth: 3 },
      status: "waiting",
      terminalSummary: null,
      updatedAt: "2026-07-25T00:00:00.000Z"
    },
    projection: {
      runId: "run_1",
      status: "waiting",
      orchestrationMode: "autonomous",
      activeStepId: "stp_1",
      stepCount: 3,
      maxSteps: 8,
      maxDepth: 3
    },
    cycles: [],
    checkpoint: null,
    decisions: [],
    participants: [agent("steward")],
    sessions: [],
    exchanges: [],
    exchangeCounts: [],
    steps: overrides.steps ?? [],
    outputFolders: [],
    timeline: [],
    currentWorkspaceRevision: null,
    workspaceRevisionError: null
  };
}

function step(overrides: Partial<AgentRunStepOutput> & { stepId: string; depth: number }): AgentRunStepOutput {
  const { stepId, depth, status, prompt, ...rest } = overrides;
  return {
    stepId,
    cycleId: null,
    parentStepId: null,
    depth,
    agent: agent("steward"),
    requestEventId: `evt_${stepId}`,
    resultEventId: null,
    status: status ?? "succeeded",
    prompt: prompt ?? "prompt",
    effectivePrompt: null,
    result: null,
    rawOutput: null,
    error: null,
    invocation: null,
    observedWorkspaceRevision: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    completedAt: null,
    ...rest
  };
}

function agent(handle: string) {
  return {
    principalId: `agent-${handle}`,
    handle,
    client: "codex" as const,
    status: "active" as const
  };
}
