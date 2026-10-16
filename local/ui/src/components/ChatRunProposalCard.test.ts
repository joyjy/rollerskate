import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatRunProposalCard from "./ChatRunProposalCard.vue";
import type { ChatRunProposal } from "@/types/local";

const proposal: ChatRunProposal = {
  schema: "ChatRunProposalView@2", proposalId: "proposal", revision: "revision",
  sourceMessageEventId: "owner", sourceRootEventId: "owner", dispatchEventId: "dispatch",
  createdAt: "2026-09-15T00:00:00Z", chatLead: { agentId: "lead", handle: "codex" },
  finalForm: { schema: "ChatRunProposalDraft@1", goal: "Read the repository", desiredEffect: "read",
    scope: { include: ["Assess next steps"], exclude: ["Do not write"] }, acceptance: ["Cite evidence"] },
  ready: false, participants: [],
  blocker: { code: "clarification_required", action: "reply", message: "Which repository?" },
  workspaceChoices: [{ kind: "project", label: "Project", root: "/repo" }, { kind: "path", label: "Other Git workspace" }],
  selectedWorkspace: { kind: "project", root: "/repo" }
};

describe("ChatRunProposalCard workspace interaction", () => {
  beforeEach(()=>vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({schema:"WorkspaceCandidates@1",items:[],truncated:false}),{headers:{"Content-Type":"application/json"}}))));
  afterEach(()=>vi.unstubAllGlobals());
  it("preserves workspace edits across equivalent polling snapshots and clarifies without starting", async () => {
    const wrapper = mount(ChatRunProposalCard, { props: { proposal } });
    await flushPromises();
    await wrapper.get("input").setValue("/workspace/snippet-lab");
    await wrapper.setProps({ proposal: structuredClone(proposal) });

    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("/workspace/snippet-lab");
    await wrapper.findAll("button").find(b => b.text() === "Reply to clarify")!.trigger("click");
    expect(wrapper.emitted("clarify")?.[0]).toEqual([proposal, "/workspace/snippet-lab"]);
    expect(wrapper.emitted("start")).toBeUndefined();
    expect(wrapper.find(".start-action").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows workspace success while allowing an explicit source and answer to be checked", async () => {
    const checked = {...proposal, finalForm:{...proposal.finalForm,blockingQuestion:"Which Git workspace?"}, taskSourceChoices:[{eventId:"original",body:"Inspect service-a"}],
      selectedWorkspace:{kind:"path" as const,root:"/repo",revision:"wrk1_checked"}};
    const wrapper = mount(ChatRunProposalCard,{props:{proposal:checked}});
    await flushPromises();
    expect(wrapper.text()).toContain("Workspace checked");
    expect(wrapper.findAll("button").some(b=>b.text()==="Use workspace")).toBe(false);
    expect(wrapper.find(".start-action").exists()).toBe(false);
    await wrapper.get('[aria-label="Original task instruction"]').setValue("original");
    await wrapper.get('[aria-label="Clarification answer"]').setValue("Use the checked workspace.");
    await wrapper.findAll("button").find(b=>b.text()==="Check proposal")!.trigger("click");
    const resolution={taskSourceMessageEventId:"original",clarificationAnswer:"Use the checked workspace."};
    expect(wrapper.emitted("preflight")?.[0]).toEqual([checked,{kind:"path",path:"/repo"},resolution]);
    await wrapper.setProps({proposal:{...checked,ready:true,blocker:undefined,resolution}});
    expect(wrapper.find(".start-action").exists()).toBe(true);
    await wrapper.get('[aria-label="Clarification answer"]').setValue("Changed answer");
    expect(wrapper.find(".start-action").exists()).toBe(false);
    wrapper.unmount();
  });

  it("opens exact reply Runs without treating the original proposal as authorized", async () => {
    const wrapper = mount(ChatRunProposalCard, { props: { proposal,
      replyRuns: [{ runId: "run_a", status: "active" }, { runId: "run_b", status: "succeeded" }] } });
    const links = wrapper.get('[aria-label="Work started from replies"]').findAll("button");
    await links[1]!.trigger("click");
    expect(wrapper.emitted("openRun")?.[0]).toEqual(["run_b"]);
    expect(wrapper.text()).toContain("This proposal has not been authorized.");
    expect(wrapper.find(".start-action").exists()).toBe(false);
    wrapper.unmount();
  });
});
