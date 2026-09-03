import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ChatGovernancePanel from "@/components/ChatGovernancePanel.vue";

describe("ChatGovernancePanel", () => {
  it("emits canonical governance, participant and schedule controls", async () => {
    const agent = localAgent();
    const wrapper = mount(ChatGovernancePanel, {
      props: {
        agents: [agent],
        governance: governance(agent.principalId),
        schedules: [schedule()],
        pending: null
      }
    });

    await wrapper.findAll("button").find((button) => button.text() === "Pause Topic")!
      .trigger("click");
    await wrapper.findAll("button").find((button) => button.text() === "Remove")!
      .trigger("click");
    await wrapper.findAll("button").find((button) => button.text() === "Pause")!
      .trigger("click");

    expect(wrapper.emitted("governanceAction")).toEqual([["pause"]]);
    expect(wrapper.emitted("participantAction")?.[0]).toEqual(["remove", agent]);
    expect(wrapper.emitted("scheduleAction")).toEqual([["pause", "tas_1"]]);
    wrapper.unmount();
  });

  it("creates a recurring schedule without exposing IDs or revisions", async () => {
    const agent = localAgent();
    const wrapper = mount(ChatGovernancePanel, {
      props: {
        agents: [agent],
        governance: governance(agent.principalId),
        schedules: [],
        pending: null
      }
    });

    await wrapper.findAll("button").find((button) => button.text() === "Add")!
      .trigger("click");
    await wrapper.findAll("select")[0]!.setValue("cron");
    await wrapper.findAll("input")[0]!.setValue("15 10 * * 1-5");
    await wrapper.findAll("input")[1]!.setValue("Asia/Shanghai");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("scheduleCreate")?.[0]).toEqual([{
      kind: "cron",
      expression: "15 10 * * 1-5",
      timezone: "Asia/Shanghai",
      intent: "continue_recent"
    }]);
    expect(wrapper.text()).not.toContain("tas_");
    expect(wrapper.text()).not.toContain("revision");
    wrapper.unmount();
  });
});

function localAgent() {
  return {
    principalId: "prn_1",
    handle: "alice",
    status: "active" as const,
    client: "codex" as const,
    executionConfig: { launchArgs: [] },
    availability: { state: "ready" as const },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z"
  };
}

function governance(agentId: string) {
  return {
    governance: {
      topicId: "local_1",
      status: "active" as const,
      participants: [{
        agentId,
        status: "active" as const,
        joinedAt: "2026-08-03T00:00:00.000Z",
        governanceRevision: 2
      }],
      strategyPolicy: {
        participantMessageEnabled: true,
        scheduledEnabled: true
      },
      conversationPolicy: { defaultIntent: "continue_recent" as const, themes: [] },
      revision: 2,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z"
    },
    activeParticipantAgentIds: [agentId],
    recentReceipts: [],
    actionAvailability: {
      expectedRevision: 2,
      pause: true,
      resume: false,
      participantAddAgentIds: [],
      participantRemoveAgentIds: [agentId]
    }
  };
}

function schedule() {
  return {
    schedule: {
      scheduleId: "tas_1",
      topicId: "local_1",
      status: "active" as const,
      kind: "cron" as const,
      expression: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
      misfirePolicy: "run_once" as const,
      misfireGraceMilliseconds: 60_000,
      candidatePolicy: "deterministic_one" as const,
      intentPolicy: { kind: "continue_recent" as const },
      turnBudget: 3,
      nextRunAt: "2099-08-03T01:00:00.000Z",
      nextOccurrenceKey: "2099-08-03T01:00:00.000Z",
      revision: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z"
    },
    receipts: []
  };
}
