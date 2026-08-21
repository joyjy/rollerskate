import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "@/App.vue";
import { createConsoleRouter } from "@/router";

afterEach(() => vi.unstubAllGlobals());

describe("Console router", () => {
  it.each([
    "/console/runtime",
    "/console/events",
    "/console/agents",
    "/console/chats",
    "/console/steward",
    "/console/schedules",
    "/console/subscriptions"
  ])("preserves an explicit direct URL: %s", async (path) => {
    const router = createConsoleRouter(createMemoryHistory());
    await router.push(path);
    expect(router.currentRoute.value.fullPath).toBe(path);
  });

  it.each([
    { agents: [], expected: "agents" },
    {
      agents: [{
        principalId: "agent-1",
        handle: "reviewer",
        status: "active",
        client: "codex",
        executionConfig: { launchArgs: [] },
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z"
      }],
      expected: "chats"
    }
  ])("selects the $expected default only at /console", async ({ agents, expected }) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/local") {
        return Response.json({
          foundation: {
            deviceId: "device-1",
            deviceName: "Fixture",
            workspacePath: "/workspace",
            topicId: "topic-1",
            topicHandle: "local",
            owner: {
              principalId: "owner-1",
              kind: "owner",
              handle: "owner",
              status: "active",
              createdAt: "2026-07-24T00:00:00.000Z",
              updatedAt: "2026-07-24T00:00:00.000Z"
            },
            createdAt: "2026-07-24T00:00:00.000Z"
          },
          agents
        });
      }
      return Response.json({}, { status: 503 });
    }));
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console");
    const wrapper = mount(App, { global: { plugins: [router] } });

    await flushPromises();

    expect(router.currentRoute.value.name).toBe(expected);
    wrapper.unmount();
  });

  it("keeps a bounded local error at /console when bootstrap validation fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      foundation: null,
      agents: []
    })));
    const router = createConsoleRouter(createMemoryHistory());
    await router.push("/console");
    const wrapper = mount(App, { global: { plugins: [router] } });

    await flushPromises();

    expect(router.currentRoute.value.name).toBe("console-entry");
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "Invalid Console API response at foundation"
    );
    wrapper.unmount();
  });
});
