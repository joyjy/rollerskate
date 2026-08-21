import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AgentInvocationDetail from "@/components/AgentInvocationDetail.vue";
import type { AgentInvocationDiagnosticsOutput } from "@/api/schema";

describe("AgentInvocationDetail", () => {
  it("renders provider-absent token, turn and tool data as Unavailable", () => {
    const wrapper = mount(AgentInvocationDetail, {
      props: {
        agent: fixtureAgent(),
        status: "succeeded",
        createdAt: "2026-07-25T00:00:00.000Z",
        invocation: fixtureInvocation({ tokenUsage: undefined, turnCount: undefined, toolUsage: undefined })
      }
    });

    const text = wrapper.text();
    expect(text).toContain("Input tokensUnavailable");
    expect(text).toContain("Output tokensUnavailable");
    expect(text).toContain("Total tokensUnavailable");
    expect(text).toContain("TurnsUnavailable");
    expect(text).toContain("Tool callsUnavailable");
  });

  it("renders reported empty toolUsage as 0 tool calls", () => {
    const wrapper = mount(AgentInvocationDetail, {
      props: {
        agent: fixtureAgent(),
        status: "succeeded",
        createdAt: "2026-07-25T00:00:00.000Z",
        invocation: fixtureInvocation({ toolUsage: [] })
      }
    });

    expect(wrapper.text()).toContain("Tool calls0 tool calls");
    expect(wrapper.findAll(".tool-list li")).toHaveLength(0);
  });

  it("renders reported toolUsage items", () => {
    const wrapper = mount(AgentInvocationDetail, {
      props: {
        agent: fixtureAgent(),
        status: "succeeded",
        createdAt: "2026-07-25T00:00:00.000Z",
        invocation: fixtureInvocation({
          toolUsage: [
            { name: "Read", count: 2 },
            { name: "Write", count: 1 }
          ]
        })
      }
    });

    const items = wrapper.findAll(".tool-list li");
    expect(items).toHaveLength(2);
    expect(items[0]!.text()).toContain("Read");
    expect(items[0]!.text()).toContain("2");
    expect(items[1]!.text()).toContain("Write");
    expect(items[1]!.text()).toContain("1");
    expect(wrapper.find(".tool-summary").text()).toContain("3 tool calls");
  });

  it("renders token usage and turn count when provider reports them", () => {
    const wrapper = mount(AgentInvocationDetail, {
      props: {
        agent: fixtureAgent(),
        status: "succeeded",
        createdAt: "2026-07-25T00:00:00.000Z",
        invocation: fixtureInvocation({
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheCreationTokens: 1,
            totalTokens: 15,
            costUsd: 0.001234
          },
          turnCount: 3
        })
      }
    });

    const text = wrapper.text();
    expect(text).toContain("Input tokens10");
    expect(text).toContain("Output tokens5");
    expect(text).toContain("Cache read2");
    expect(text).toContain("Cache creation1");
    expect(text).toContain("Total tokens15");
    expect(text).toContain("Cost$0.001234");
    expect(text).toContain("Turns3");
  });

  it("is collapsed by default", () => {
    const wrapper = mount(AgentInvocationDetail, {
      props: {
        agent: fixtureAgent(),
        status: "succeeded",
        createdAt: "2026-07-25T00:00:00.000Z"
      }
    });

    expect(wrapper.find("details").attributes("open")).toBeUndefined();
  });

  it("uses effective prompt over product prompt when present", () => {
    const wrapper = mount(AgentInvocationDetail, {
      props: {
        agent: fixtureAgent(),
        status: "succeeded",
        createdAt: "2026-07-25T00:00:00.000Z",
        prompt: "product prompt",
        effectivePrompt: "effective prompt"
      }
    });

    const mainPrompt = wrapper.find(".prompt-block > .prompt-body");
    expect(mainPrompt.text()).toBe("effective prompt");
    expect(wrapper.find(".product-prompt").exists()).toBe(true);
    expect(wrapper.find(".product-prompt .prompt-body").text()).toBe("product prompt");
  });
});

function fixtureAgent() {
  return {
    principalId: "agent-1",
    handle: "steward",
    client: "codex",
    status: "active"
  };
}

function fixtureInvocation(
  overrides: Partial<AgentInvocationDiagnosticsOutput> = {}
): AgentInvocationDiagnosticsOutput {
  return {
    schemaVersion: "AgentInvocationDiagnostics@1",
    effectivePrompt: "effective prompt",
    startedAt: "2026-07-25T00:00:00.000Z",
    completedAt: "2026-07-25T00:00:01.000Z",
    durationMilliseconds: 1000,
    ...overrides
  };
}
