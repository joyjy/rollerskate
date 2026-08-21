import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import ChatTimeline from "@/components/ChatTimeline.vue";

describe("ChatTimeline", () => {
  it("emits Reply and resolves a rendered reply reference", async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const original = {
      eventId: "evt_original",
      createdAt: "2026-08-19T00:00:00.000Z",
      sender: {
        kind: "agent" as const,
        principalId: "prn_alice",
        handleSnapshot: "alice"
      },
      body: "The referenced claim."
    };
    const reply = {
      eventId: "evt_reply",
      createdAt: "2026-08-19T00:01:00.000Z",
      sender: {
        kind: "owner" as const,
        principalId: "prn_owner",
        handleSnapshot: "owner"
      },
      body: "This responds to it.",
      replyToEventId: original.eventId,
      targets: [
        { principalId: "prn_alice", handleSnapshot: "alice" },
        { principalId: "prn_bob", handleSnapshot: "bob" }
      ]
    };
    const wrapper = mount(ChatTimeline, {
      attachTo: document.body,
      props: {
        chat: {
          id: "local",
          kind: "local",
          handle: "#local",
          name: "Local",
          status: "active",
          unreadCount: 0
        },
        messages: [original, reply],
        activeAgents: [],
        allowReply: true
      }
    });

    await wrapper.findAll("button.reply-action")[0]!.trigger("click");
    expect(wrapper.emitted("reply")?.[0]?.[0]).toEqual(original);
    expect(wrapper.get("button.reply-reference").text()).toContain("alice");
    expect(wrapper.get("button.reply-reference").text()).toContain("The referenced claim.");
    expect(wrapper.text()).toContain("to @alice, @bob");

    await wrapper.get("button.reply-reference").trigger("click");
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement?.getAttribute("data-event-id")).toBe(original.eventId);
    wrapper.unmount();
  });
});
