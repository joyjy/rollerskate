import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import type { RuntimeAuditOutput } from "@/api/schema";
import AgentInvocationDetail from "@/components/AgentInvocationDetail.vue";
import EventAuditPanel from "@/components/EventAuditPanel.vue";

describe("EventAuditPanel", () => {
  it("renders AgentInvocationDetail when audit.invocation exists", () => {
    const wrapper = mount(EventAuditPanel, {
      props: {
        audit: fixtureAudit({ invocation: fixtureInvocation() })
      }
    });

    const detail = wrapper.findComponent(AgentInvocationDetail);
    expect(detail.exists()).toBe(true);
    expect(detail.props("invocation")).toEqual(fixtureInvocation());
    expect(detail.props("requestEventId")).toBe("evt_request");
    expect(detail.props("resultEventId")).toBe("evt_result");
    expect(detail.props("effectivePrompt")).toBe("effective prompt");
    expect(detail.props("rawOutput")).toBe("done");
  });

  it("does not render AgentInvocationDetail when audit.invocation is absent", () => {
    const wrapper = mount(EventAuditPanel, {
      props: {
        audit: fixtureAudit({ invocation: null })
      }
    });

    expect(wrapper.findComponent(AgentInvocationDetail).exists()).toBe(false);
  });

  it("shows empty state when no audit is selected", () => {
    const wrapper = mount(EventAuditPanel, {
      props: { audit: undefined }
    });

    expect(wrapper.text()).toContain("Select an Event to inspect its durable audit chain.");
  });

  it("renders a root conversation timeline with agent, execution and stop reason", () => {
    const wrapper = mount(EventAuditPanel, {
      props: {
        audit: fixtureAudit({
          conversationTimeline: [{
            eventId: "evt_dispatch",
            type: "chat.dispatch",
            parentEventId: "evt_activation",
            agentHandle: "kimi",
            sessionId: "ses_kimi",
            executionId: "exe_kimi",
            status: "stopped",
            outcome: "silent",
            reason: "turn-budget-exhausted",
            createdAt: "2026-07-25T00:00:00.000Z",
            completedAt: "2026-07-25T00:00:01.000Z",
            durationMilliseconds: 1_000
          }]
        })
      }
    });

    expect(wrapper.text()).toContain("Conversation root timeline");
    expect(wrapper.text()).toContain("Agent @kimi");
    expect(wrapper.text()).toContain("Execution exe_kimi");
    expect(wrapper.text()).toContain("turn-budget-exhausted");
  });
});

function fixtureAudit(
  overrides: Partial<RuntimeAuditOutput> = {}
): RuntimeAuditOutput {
  return {
    event: {
      eventId: "evt_request",
      type: "agent.request",
      source: { kind: "console", externalId: null },
      agentId: "agent-steward",
      sessionId: null,
      destinationIds: [],
      causality: {
        rootEventId: "evt_root",
        parentEventId: null,
        hop: 0
      },
      prompt: "product prompt",
      body: null,
      createdAt: "2026-07-25T00:00:00.000Z"
    },
    execution: {
      executionId: "exec_1",
      handler: "agent",
      status: "succeeded",
      attemptCount: 1,
      maxAttempts: 3,
      firstStartedAt: "2026-07-25T00:00:00.000Z",
      lastAttemptAt: "2026-07-25T00:00:00.000Z",
      completedAt: "2026-07-25T00:00:01.000Z",
      nextAttemptAt: null,
      lastError: null
    },
    resultEvent: {
      eventId: "evt_result",
      type: "agent.result",
      outcome: "succeeded",
      output: "done",
      error: null,
      createdAt: "2026-07-25T00:00:01.000Z",
      causality: {
        rootEventId: "evt_root",
        parentEventId: "evt_request",
        hop: 1
      }
    },
    resultExecution: null,
    session: null,
    deliveries: [],
    directChildren: [],
    conversationTimeline: [],
    lifecycleChangedAt: "2026-07-25T00:00:01.000Z",
    reasonForIntervention: null,
    causalityBoundary: null,
    ...overrides
  } as RuntimeAuditOutput;
}

function fixtureInvocation() {
  return {
    schemaVersion: "AgentInvocationDiagnostics@1" as const,
    effectivePrompt: "effective prompt",
    startedAt: "2026-07-25T00:00:00.000Z",
    completedAt: "2026-07-25T00:00:01.000Z",
    durationMilliseconds: 1000,
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    turnCount: 1
  };
}
