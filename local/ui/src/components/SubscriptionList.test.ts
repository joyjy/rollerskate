import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import SubscriptionList from "@/components/SubscriptionList.vue";
import type { Subscription } from "@/types/subscription";

describe("SubscriptionList", () => {
  it("uses keyboard-operable rows with selected state", async () => {
    const subscription = fixtureSubscription();
    const wrapper = mount(SubscriptionList, {
      props: {
        subscriptions: [subscription],
        selectedId: subscription.id
      }
    });
    const row = wrapper.get("button.subscription-row");

    expect(row.attributes("type")).toBe("button");
    expect(row.attributes("aria-selected")).toBe("true");
    await row.trigger("click");
    expect(wrapper.emitted("select")).toEqual([[subscription.id]]);
  });
});

function fixtureSubscription(): Subscription {
  return {
    kind: "free",
    id: "sub-1",
    title: "Fixture pipeline",
    status: "active",
    owner: { agentId: "agent-1", handle: "reviewer", client: "codex" },
    definition: {
      schema: "SubscriptionDefinition@3",
      revision: "fixture-v1",
      digest: "definition-digest",
      callbackPhaseStatus: "pending",
      artifactRevision: "probe-v1",
      artifactDigest: `sha256:${"0".repeat(64)}`,
      callbacks: []
    },
    callbacks: [],
    probe: {
      plugin: { id: "fixture", path: "/plugin.ts", schemaVersion: 1 },
      policy: {
        allowedHttpOrigins: [],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 1_000,
        maxOutputBytes: 4_096
      }
    },
    schedule: {
      intervalMilliseconds: 1_000,
      maxWaitMilliseconds: 60_000,
      maxAttempts: 60,
      attemptCount: 0,
      deadlineAt: "2026-07-24T00:01:00.000Z",
      nextPollAt: "2026-07-24T00:00:01.000Z"
    },
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    latestError: null,
    terminalObservation: null
  };
}
