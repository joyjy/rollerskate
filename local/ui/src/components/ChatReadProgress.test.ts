import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it } from "vitest";

import ChatReadProgress from "@/components/ChatReadProgress.vue";

describe("ChatReadProgress", () => {
  it("renders completed and actively reading progress with an accessible per-Agent detail", async () => {
    const wrapper = mount(ChatReadProgress, {
      attachTo: document.body,
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
              state: "reading",
              reason: "available"
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
    expect(summary.attributes("aria-label")).toBe("1 of 3 Agents read this message; 1 reading; 1 failed");
    expect(wrapper.get(".progress-ring").attributes("style")).toContain("--read-degrees: 120deg");
    expect(wrapper.get(".progress-ring").attributes("style")).toContain("--active-degrees: 240deg");
    expect(wrapper.get(".progress-ring").attributes("style")).toContain("--resolved-degrees: 360deg");

    await wrapper.get("details").trigger("mouseenter");
    await nextTick();
    expect(document.body.querySelector(".progress-detail")?.textContent).toContain("Reading");

    await summary.trigger("click");
    expect(wrapper.get("details").attributes()).toHaveProperty("open");
    await wrapper.get("details").trigger("toggle");

    const detail = document.body.querySelector<HTMLElement>(".progress-detail");
    expect(detail).not.toBeNull();
    expect(detail?.parentElement).toBe(document.body);
    expect(detail?.textContent).toContain("1/3 read");
    expect(detail?.textContent).toContain("@alice");
    expect(detail?.textContent).toContain("Done");
    expect(detail?.textContent).toContain("Reading");
    expect(detail?.textContent).toContain("Failed");
    expect(detail?.textContent).toContain("provider unavailable");

    wrapper.unmount();
  });
});
