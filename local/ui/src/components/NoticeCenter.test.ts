import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import NoticeCenter from "@/components/NoticeCenter.vue";
import { createConsoleRouter } from "@/router";

const noticeId = "ntc1_del_018f5f21-1234-7abc-8def-1234567890ab";
const summary = {
  noticeId,
  title: "Pipeline complete",
  summary: "Implemented the requested change.",
  outcome: "succeeded",
  deliveryStatus: "delivered",
  statusReason: "The Agent result was delivered as a local notification.",
  source: {
    kind: "delivery",
    sourceId: "del_018f5f21-1234-7abc-8def-1234567890ab",
    subscriptionId: "sub_fixture"
  },
  references: {
    eventId: "evt_fixture",
    deliveryId: "del_018f5f21-1234-7abc-8def-1234567890ab",
    destinationId: "dst_fixture"
  },
  sourceAction: {
    label: "Inspect Subscription",
    consoleRoute: "/console/subscriptions?subscriptionId=sub_fixture",
    cliHint: "scripts/rs subscription inspect sub_fixture"
  },
  failure: null,
  occurredAt: "2026-07-25T03:00:00.000Z",
  deliveredAt: "2026-07-25T03:00:01.000Z",
  readAt: null,
  acknowledgedAt: null,
  availableActions: {
    markRead: true,
    acknowledge: true
  }
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Notice Center", () => {
  it("opens a deep-linked notice, exposes unread count, and acknowledges durably", async () => {
    let acknowledged = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/ack") && init?.method === "POST") {
        acknowledged = true;
        return Response.json({
          summary: {
            ...summary,
            readAt: "2026-07-25T03:01:00.000Z",
            acknowledgedAt: "2026-07-25T03:01:00.000Z",
            availableActions: { markRead: false, acknowledge: false }
          },
          projection: {
            projectionUpdatedAt: "2026-07-25T03:00:01.000Z",
            stateUpdatedAt: "2026-07-25T03:01:00.000Z",
            deliveryError: null
          }
        });
      }
      if (path.startsWith("/api/notices?")) {
        return Response.json({
          counts: {
            total: 1,
            unread: acknowledged ? 0 : 1,
            unacknowledged: acknowledged ? 0 : 1
          },
          notices: [{
            ...summary,
            ...(acknowledged
              ? {
                  readAt: "2026-07-25T03:01:00.000Z",
                  acknowledgedAt: "2026-07-25T03:01:00.000Z",
                  availableActions: { markRead: false, acknowledge: false }
                }
              : {})
          }]
        });
      }
      return Response.json({
        summary,
        projection: {
          projectionUpdatedAt: "2026-07-25T03:00:01.000Z",
          stateUpdatedAt: null,
          deliveryError: null
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createConsoleRouter(createMemoryHistory());
    await router.push(`/console/runtime?noticeId=${encodeURIComponent(noticeId)}`);
    const wrapper = mount(NoticeCenter, {
      attachTo: document.body,
      global: { plugins: [router] }
    });

    await flushPromises();

    expect(wrapper.get(".notice-count").text()).toBe("1");
    const drawer = document.body.querySelector(".notice-drawer");
    expect(drawer?.textContent).toContain("Pipeline complete");
    expect(drawer?.textContent).toContain("Acknowledge");

    const acknowledge = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.trim() === "Acknowledge");
    expect(acknowledge).toBeDefined();
    acknowledge?.click();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/notices/${encodeURIComponent(noticeId)}/ack`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Rollerskate-Request": "console"
        })
      })
    );
    expect(wrapper.find(".notice-count").exists()).toBe(false);
    expect(Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button")
    ).some((button) => button.textContent?.trim() === "Acknowledge")).toBe(false);
    wrapper.unmount();
  });

  it("preserves a Runtime Failure target while dismissing the drawer", async () => {
    const failed = {
      ...summary,
      deliveryStatus: "failed",
      failure: {
        failureRef:
          "failure:delivery:del_018f5f21-1234-7abc-8def-1234567890ab",
        consoleRoute:
          "/console/runtime?failureRef=failure%3Adelivery%3Adel_018f5f21-1234-7abc-8def-1234567890ab"
      }
    } as const;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      return Response.json(String(input).startsWith("/api/notices?")
        ? {
            counts: { total: 1, unread: 1, unacknowledged: 1 },
            notices: [failed]
          }
        : {
            summary: failed,
            projection: {
              projectionUpdatedAt: "2026-07-25T03:00:01.000Z",
              stateUpdatedAt: null,
              deliveryError: "Notification Center unavailable"
            }
          });
    }));
    const router = createConsoleRouter(createMemoryHistory());
    await router.push(`/console/runtime?noticeId=${encodeURIComponent(noticeId)}`);
    const wrapper = mount(NoticeCenter, {
      attachTo: document.body,
      global: { plugins: [router] }
    });
    await flushPromises();

    const failureLink = document.body.querySelector<HTMLAnchorElement>(
      "a.notice-link.danger"
    );
    expect(failureLink).not.toBeNull();
    failureLink?.click();
    await flushPromises();

    expect(router.currentRoute.value.query.failureRef).toBe(
      failed.failure.failureRef
    );
    expect(router.currentRoute.value.query.noticeId).toBeUndefined();
    expect(document.body.querySelector(".notice-drawer")).toBeNull();
    wrapper.unmount();
  });
});
