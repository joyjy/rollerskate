import { mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { describe, expect, it } from "vitest";

import AgentRunOverview from "@/components/AgentRunOverview.vue";
import { createConsoleRouter } from "@/router";

describe("AgentRunOverview", () => {
  it("shows generic Run progress, links to the Event trace and exposes cancel", async () => {
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/runtime");
    const wrapper = mount(AgentRunOverview, {
      global: { plugins: [router] },
      props: {
        run: {
          summary: {
            runId: "run_1",
            rootEventId: "evt_root",
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
            activeStepId: "stp_1",
            stepCount: 3,
            maxSteps: 8,
            maxDepth: 3
          },
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
});

function agent(handle: string) {
  return {
    principalId: `agent-${handle}`,
    handle,
    client: "codex" as const,
    status: "active" as const
  };
}
