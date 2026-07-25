import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AddAgentModal from "@/components/AddAgentModal.vue";
import AgentRoster from "@/components/AgentRoster.vue";
import type { AgentConsoleItem } from "@/types/local";

describe("Agent components", () => {
  it("renders the roster as selected keyboard-operable buttons", async () => {
    const agent = fixtureAgent();
    const wrapper = mount(AgentRoster, {
      props: { agents: [agent], selectedId: agent.principalId }
    });
    const row = wrapper.get("button.roster-row");
    expect(row.attributes("aria-selected")).toBe("true");
    await row.trigger("click");
    expect(wrapper.emitted("select")).toEqual([[agent.principalId]]);
  });

  it("focuses the first input when the Add Agent dialog opens", () => {
    const wrapper = mount(AddAgentModal, {
      attachTo: document.body,
      props: {
        handle: "",
        client: "codex",
        launchArgsText: "",
        pending: false,
        error: null
      }
    });
    expect(document.activeElement).toBe(wrapper.get("#new-handle").element);
    expect(wrapper.get('[role="dialog"]').attributes("aria-modal")).toBe("true");
    wrapper.unmount();
  });
});

function fixtureAgent(): AgentConsoleItem {
  return {
    principalId: "agent-1",
    handle: "reviewer",
    status: "active",
    client: "codex",
    executionConfig: { launchArgs: [] },
    availability: { state: "ready" },
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}
