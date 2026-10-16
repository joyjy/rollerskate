import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentRunRecovery from "./AgentRunRecovery.vue";
const intervention = {schemaVersion: "RunIntervention@1" as const, kind: "manual_fallback" as const,
  runId: "run_original", runVersion: 2, requestEventId: "evt_request", resultExecutionId: "exe_result",
  reason: "Unknown field inputFacts", allowedActions: ["decide", "cancel"] as ("decide"|"cancel"|"retry_orchestrator")[]};
const proposal = {revision: "draft1", runVersion: 2, action: "next_step", reason: "修正协议字段",
  effect: "@codex: 执行原已授权任务", workspace: "/original", checkedAcceptance: ["保留原验收"]};
function button(wrapper: ReturnType<typeof mount>, text: string) { return wrapper.findAll("button").find(b => b.text() === text)!; }
afterEach(() => vi.unstubAllGlobals());
describe("Chat Run recovery", () => {
  it("requests an agent-authored proposal without exposing a JSON editor or executing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({proposal:null}))); vi.stubGlobal("fetch",fetch);
    const wrapper = mount(AgentRunRecovery,{props:{runId:"run_original",intervention}}); await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("重试只读编排");
    await button(wrapper,"请 agent 准备方案").trigger("click");
    expect(wrapper.emitted("request")).toHaveLength(1);
    expect(fetch.mock.calls).toHaveLength(1); wrapper.unmount();
  });
  it("reviews actual effects and confirms only the exact prepared revision", async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/recovery') ? {proposal} : {status:"accepted"})));
    vi.stubGlobal("fetch",fetch);
    const wrapper = mount(AgentRunRecovery,{props:{runId:"run_original",intervention}}); await flushPromises();
    expect(wrapper.text()).toContain(proposal.effect);
    await button(wrapper,"审阅并继续").trigger("click");
    expect(fetch.mock.calls).toHaveLength(1);
    await button(wrapper,"确认").trigger("click"); await flushPromises();
    const mutation = fetch.mock.calls.find(call => call[0].endsWith("/confirm-recovery"))! as unknown as [string, RequestInit];
    expect(JSON.parse(String(mutation[1].body)).revision).toBe("draft1");
    expect(wrapper.emitted("changed")).toHaveLength(1); wrapper.unmount();
  });
  it("invalidates review after Run version changes", async () => {
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({proposal}))));
    const wrapper = mount(AgentRunRecovery,{props:{runId:"run_original",intervention}}); await flushPromises();
    await button(wrapper,"审阅并继续").trigger("click");
    await wrapper.setProps({intervention:{...intervention,runVersion:3}});
    expect(wrapper.find('[aria-label="Confirm recovery action"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("审阅并继续"); wrapper.unmount();
  });
});
