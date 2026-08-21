import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import * as v from "valibot";

import {
  runtimeAuditSchema,
  type RuntimeAuditOutput
} from "@/api/schema";
import EventList from "@/components/EventList.vue";

describe("EventList", () => {
  it("does not auto-select a visible row when filters hide the selected Event", async () => {
    const first = audit("evt-first");
    const second = audit("evt-selected");
    const wrapper = mount(EventList, {
      props: {
        audits: [first, second],
        selectedId: second.event.eventId,
        loading: false,
        error: null,
        runtimePaused: false,
        runtimeStale: false
      }
    });

    await wrapper.get('input[type="search"]').setValue("evt-first");

    const rows = wrapper.findAll("button.event-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attributes("aria-selected")).toBe("false");
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("accepts null audit relations for Events without an Execution", () => {
    expect(v.parse(runtimeAuditSchema, {
      ...audit("evt-chat-message"),
      execution: null,
      resultEvent: null,
      resultExecution: null,
      session: null
    }).event.eventId).toBe("evt-chat-message");
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
    deliveries: [],
    lifecycleChangedAt: "2026-07-24T00:00:00.000Z",
    reasonForIntervention: null,
    directChildren: [],
    causalityBoundary: "complete"
  };
}
