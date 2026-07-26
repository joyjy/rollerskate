import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ChatReadProgress from "@/components/ChatReadProgress.vue";

describe("ChatReadProgress", () => {
  it("renders clockwise progress with an accessible per-Agent detail", async () => {
    const wrapper = mount(ChatReadProgress, {
      props: {
        progress: {
          schema: "ChatReadProgress@1",
          total: 3,
          read: 1,
          agents: [
            {
              agentId: "agent-a",
              handleSnapshot: "alice",
              state: "read",
              reason: "direct-mention"
            },
            {
              agentId: "agent-b",
              handleSnapshot: "bob",
              state: "unread",
              reason: "not-target"
            },
            {
              agentId: "agent-c",
              handleSnapshot: "carol",
              state: "failed",
              reason: "available",
              failureReason: "provider unavailable"
            }
          ]
        }
      }
    });

    const summary = wrapper.get("summary");
    expect(summary.attributes("aria-label")).toBe("1 of 3 Agents read this message");
    expect(wrapper.get(".progress-ring").attributes("style")).toContain("120deg");
    expect(wrapper.get(".progress-detail").text()).toContain("1/3 read");
    expect(wrapper.get(".progress-detail").text()).toContain("@alice");
    expect(wrapper.get(".progress-detail").text()).toContain("Failed");
    expect(wrapper.get(".progress-detail").text()).toContain("provider unavailable");

    await summary.trigger("click");
    expect(wrapper.get("details").attributes()).toHaveProperty("open");
  });
});
