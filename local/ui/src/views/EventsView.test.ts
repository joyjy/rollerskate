import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestJson } from "@/api/client";
import type { RuntimeAuditOutput } from "@/api/schema";
import { createConsoleRouter } from "@/router";
import EventsView from "@/views/EventsView.vue";

vi.mock("@/api/client", () => ({
  boundedError: (error: unknown) => error instanceof Error ? error.message : String(error),
  requestJson: vi.fn()
}));

const mockedRequestJson = vi.mocked(requestJson);

describe("EventsView", () => {
  beforeEach(() => {
    mockedRequestJson.mockReset();
  });

  it("loads the selected Event detail separately from the polling list", async () => {
    const newest = audit("evt-new");
    const older = audit("evt-old");
    mockedRequestJson.mockImplementation(async (path) => {
      if (path === "/api/events") return [newest, older];
      if (path === "/api/runtime") {
        return { status: "stopped", stale: false };
      }
      if (path === "/api/events/evt-new") {
        return {
          ...newest,
          conversationTimeline: [{
            eventId: "evt-new",
            type: "chat.activation",
            status: "succeeded",
            reason: "manual",
            createdAt: newest.event.createdAt
          }]
        };
      }
      throw new Error(`unexpected request: ${path}`);
    });

    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console/events");
    const wrapper = mount(EventsView, { global: { plugins: [router] } });
    await flushPromises();

    expect(mockedRequestJson.mock.calls.some(([path]) =>
      path === "/api/events/evt-new")).toBe(true);
    expect(wrapper.text()).toContain("manual");
    wrapper.unmount();
  });
});

function audit(eventId: string): RuntimeAuditOutput {
  return {
    event: {
      eventId,
      type: "agent.request",
      source: { kind: "cli" },
      destinationIds: [],
      causality: { rootEventId: eventId, hop: 0 },
      createdAt: "2026-07-24T00:00:00.000Z"
    },
    execution: null,
    deliveries: [],
    lifecycleChangedAt: "2026-07-24T00:00:00.000Z",
    reasonForIntervention: null,
    directChildren: [],
    causalityBoundary: "complete"
  };
}
