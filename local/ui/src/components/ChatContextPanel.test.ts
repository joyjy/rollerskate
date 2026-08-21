import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ChatContextPanel from "@/components/ChatContextPanel.vue";
import type { LocalAgent } from "@/types/local";

describe("ChatContextPanel", () => {
  it("separates client identity, topic presence, and suspended lifecycle", async () => {
    const codex = fixtureAgent("agent-codex", "codex", "codex", "active");
    const kimi = fixtureAgent("agent-kimi", "kimi", "kimi-code", "suspended");
    const futureAgent = fixtureAgent("agent-future", "future", "future-client", "active");
    const wrapper = mount(ChatContextPanel, {
      props: {
        agents: [kimi, futureAgent, codex],
        presenceAgents: [
          {
            principalId: codex.principalId,
            handle: codex.handle,
            status: codex.status,
            topic: { scope: "topic", mode: "available", wakeKeywords: [] },
            clientHistory: {
              client: "codex",
              status: "active",
              updatedAt: "2026-07-31T00:00:00.000Z",
              coverage: "unavailable"
            },
            lastTurn: {
              state: "silent",
              at: "2026-07-31T00:00:00.000Z",
              reason: "The useful point was already covered."
            }
          },
          {
            principalId: kimi.principalId,
            handle: kimi.handle,
            status: kimi.status
          },
          {
            principalId: futureAgent.principalId,
            handle: futureAgent.handle,
            status: futureAgent.status
          }
        ],
        sessions: [],
        pending: null
      }
    });

    const rows = wrapper.findAll(".session-row");
    expect(rows[0]?.text()).toContain("@codex");
    expect(rows[0]?.text()).toContain("Codex");
    expect(rows[0]?.text()).toContain("Listening");
    expect(rows[0]?.text()).toContain("stayed silent");
    expect(rows[0]?.text()).toContain("already covered");
    expect(rows[0]?.text()).toContain("Source unavailable");
    expect(rows[1]?.text()).toContain("@future");
    expect(rows[1]?.text()).toContain("future-client");
    expect(rows[2]?.classes()).toContain("suspended");
    expect(rows[2]?.text()).toContain("Suspended");

    await rows[0]!.get("button.presence-control").trigger("click");
    const future = new Date(Date.now() + 60 * 60 * 1_000);
    const offset = future.getTimezoneOffset() * 60_000;
    const localFuture = new Date(future.getTime() - offset).toISOString().slice(0, 16);
    await wrapper.get('input[type="datetime-local"]').setValue(localFuture);
    const snoozeButton = wrapper.findAll(".presence-editor button")
      .find((button) => button.text() === "Snooze");
    expect(snoozeButton).toBeDefined();
    await snoozeButton!.trigger("click");

    const emitted = wrapper.emitted("setPresence");
    expect(emitted).toHaveLength(1);
    expect(emitted?.[0]?.[0]).toEqual(codex);
    expect(emitted?.[0]?.[1]).toMatchObject({
      mode: "snoozed",
      until: new Date(localFuture).toISOString()
    });
  });
});

function fixtureAgent(
  principalId: string,
  handle: string,
  client: LocalAgent["client"],
  status: LocalAgent["status"]
): LocalAgent {
  return {
    principalId,
    handle,
    client,
    status,
    executionConfig: { launchArgs: [] },
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}
