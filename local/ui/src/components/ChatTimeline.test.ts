import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChatTimeline from "@/components/ChatTimeline.vue";

describe("ChatTimeline", () => {
  afterEach(() => vi.unstubAllGlobals());

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
        allowReply: true,
      }
    });

    await wrapper.findAll("button.reply-action")[0]!.trigger("click");
    expect(wrapper.emitted("reply")?.[0]?.[0]).toEqual(original);
    expect(wrapper.find("button.handoff-action").exists()).toBe(false);
    expect(wrapper.get("button.reply-reference").text()).toContain("alice");
    expect(wrapper.get("button.reply-reference").text()).toContain("The referenced claim.");
    expect(wrapper.text()).toContain("to @alice, @bob");

    await wrapper.get("button.reply-reference").trigger("click");
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement?.getAttribute("data-event-id")).toBe(original.eventId);
    wrapper.unmount();
  });

  it("renders one proposal action and replaces it with linked Run readback", async () => {
    const proposal = {
      schema: "ChatRunProposalView@2" as const,
      proposalId: "chat-proposal:evt_owner:evt_dispatch",
      revision: `sha256:${"a".repeat(64)}`,
      sourceMessageEventId: "evt_owner",
      sourceRootEventId: "evt_owner",
      dispatchEventId: "evt_dispatch",
      createdAt: "2026-09-02T04:00:00.000Z",
      chatLead: { agentId: "prn_alice", handle: "alice" },
      finalForm: {
        schema: "ChatRunProposalDraft@1" as const,
        goal: "Trace the checkout regression",
        scope: { include: ["Inspect the failing path"], exclude: ["Do not deploy"] },
        acceptance: ["Root cause is evidenced"],
        desiredEffect: "read" as const,
        workspaceRef: "local:workspace" as const
      },
      ready: true,
      workspaceChoices: [
        { kind: "project" as const, label: "Rollerskate source", root: "/repo" },
        { kind: "path" as const, label: "Other Git workspace" }
      ],
      selectedWorkspace: { kind: "project" as const, root: "/repo" },
      runOrchestrator: { agentId: "prn_codex", handle: "codex" },
      participants: [
        { agentId: "prn_alice", handle: "alice" },
        { agentId: "prn_codex", handle: "codex" }
      ],
      authority: {
        summary: "workspace=read; network=off",
        workspace: {
          root: "/repo",
          revision: `wrk1_${"b".repeat(64)}`,
          access: "read" as const,
          networkAccess: false
        },
        maxSteps: 20,
        maxDepth: 0
      }
    };
    const message = {
      eventId: "evt_owner",
      createdAt: "2026-09-02T03:59:00.000Z",
      sender: {
        kind: "owner" as const,
        principalId: "prn_owner",
        handleSnapshot: "owner"
      },
      body: "Please inspect this regression.",
      runProposals: [proposal]
    };
    const wrapper = mount(ChatTimeline, {
      props: {
        chat: {
          id: "local",
          kind: "local",
          handle: "#local",
          name: "Local",
          status: "active",
          unreadCount: 0
        },
        messages: [message],
        activeAgents: [],
      }
    });

    expect(wrapper.text()).toContain("Trace the checkout regression");
    expect(wrapper.text()).toContain("Inspect the failing path");
    expect(wrapper.text()).toContain("Root cause is evidenced");
    expect(wrapper.text()).toContain("Chat Lead");
    expect(wrapper.text()).toContain("@alice");
    expect(wrapper.text()).toContain("Run Orchestrator");
    expect(wrapper.text()).toContain("@codex");
    expect(wrapper.find("button.handoff-action").exists()).toBe(false);
    await wrapper.get("button.start-action").trigger("click");
    expect(wrapper.emitted("confirmProposal")?.[0]?.[0]).toEqual(proposal);
    expect(wrapper.emitted("confirmProposal")?.[0]?.[1]).toEqual({ kind: "project" });

    const replyWork = { kind: "agent" as const, runId: "run_reply", state: "started" as const,
      status: "active" as const, updatedAt: "2026-09-15T00:00:00Z" };
    await wrapper.setProps({ messages: [message, {
      ...message, eventId: "reply", runProposals: [], replyToEventId: message.eventId,
      works: [replyWork]
    }, {
      ...message, eventId: "unrelated", runProposals: [], replyToEventId: "some_other_message",
      works: [{ ...replyWork, runId: "run_unrelated" }]
    }] });
    const replyLinks = wrapper.get('[aria-label="Work started from replies"]');
    expect(replyLinks.text()).toContain("run_reply");
    expect(replyLinks.text()).not.toContain("run_unrelated");
    await replyLinks.get("button").trigger("click");
    expect(wrapper.emitted("openRun")?.[0]).toEqual(["run_reply"]);

    await wrapper.setProps({
      messages: [{
        ...message,
        runProposals: [{
          ...proposal,
          ready: false,
          selectedWorkspace: undefined,
          authority: undefined,
          blocker: {
            code: "workspace_required" as const,
            message: "Which checkout should the Run inspect?",
            action: "choose_workspace" as const
          }
        }]
      }]
    });
    expect(wrapper.find("button.start-action").exists()).toBe(false);
    expect(wrapper.text()).toContain("Workspace required");
    expect(wrapper.text()).toContain("Which checkout should the Run inspect?");
    await wrapper.get("button.secondary-action").trigger("click");
    expect(wrapper.emitted("preflightProposal")?.[0]?.[0]).toEqual({
      ...proposal,
      ready: false,
      selectedWorkspace: undefined,
      authority: undefined,
      blocker: {
        code: "workspace_required",
        message: "Which checkout should the Run inspect?",
        action: "choose_workspace"
      }
    });
    expect(wrapper.emitted("preflightProposal")?.[0]?.[1]).toEqual({ kind: "project" });

    await wrapper.setProps({
      messages: [{
        ...message,
        runProposals: [{
          ...proposal,
          ready: false,
          blocker: {
            code: "workspace_required" as const,
            message: "Stale workspace blocker",
            action: "choose_workspace" as const
          },
          linkedRun: {
            runId: "run_1",
            state: "needs_human" as const,
            status: "awaiting_orchestrator" as const,
            terminal: false,
            attentionReason: "Owner must choose the target branch.",
            updatedAt: "2026-09-02T04:02:00.000Z"
          }
        }]
      }]
    });
    expect(wrapper.find("button.start-action").exists()).toBe(false);
    expect(wrapper.text()).toContain("Run needs human · blocked");
    expect(wrapper.text()).toContain("Owner must choose the target branch.");
    expect(wrapper.text()).not.toContain("Stale workspace blocker");
    await wrapper.get("button.secondary-action").trigger("click");
    expect(wrapper.emitted("openRun")?.at(-1)?.[0]).toBe("run_1");

    await wrapper.setProps({
      messages: [{
        ...message,
        runProposals: [{
          ...proposal,
          linkedRun: {
            runId: "run_1",
            state: "terminal" as const,
            status: "succeeded" as const,
            terminalSummary: "Regression traced to the checkout cache.",
            terminal: true,
            outputs: [{ outputId: "out_report", stepId: "step_report", title: "Investigation report",
              kind: "output" as const, contentType: "text/markdown" }],
            updatedAt: "2026-09-02T04:03:00.000Z"
          }
        }]
      }]
    });
    expect(wrapper.text()).toContain("Run succeeded");
    expect(wrapper.text()).toContain("Regression traced to the checkout cache.");
    expect(wrapper.text()).toContain("Investigation report");
  });

  it("follows added content only from the latest position and offers a return control otherwise", async () => {
    const message = {
      eventId: "evt_1",
      createdAt: "2026-09-16T00:00:00.000Z",
      sender: {kind: "owner" as const, principalId: "prn_owner", handleSnapshot: "owner"},
      body: "First message"
    };
    const wrapper = mount(ChatTimeline, {attachTo: document.body, props: {
      chat: {id: "local", kind: "local", handle: "#local", name: "Local", status: "active", unreadCount: 0},
      messages: [message], activeAgents: []
    }});
    const timeline = wrapper.get(".timeline").element;
    let height = 500;
    Object.defineProperty(timeline, "scrollHeight", {configurable: true, get: () => height});
    Object.defineProperty(timeline, "clientHeight", {configurable: true, get: () => 100});
    timeline.scrollTop = 400;

    height = 600;
    await wrapper.setProps({messages: [...wrapper.props("messages"), {...message, eventId: "evt_2", body: "Latest message"}]});
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(timeline.scrollTop).toBe(600);

    timeline.scrollTop = 120;
    await wrapper.get(".timeline").trigger("scroll");
    height = 700;
    await wrapper.setProps({messages: [...wrapper.props("messages"), {...message, eventId: "evt_3", body: "Do not interrupt reading"}]});
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(timeline.scrollTop).toBe(120);
    await wrapper.get(".new-content-button").trigger("click");
    expect(timeline.scrollTop).toBe(700);
    wrapper.unmount();
  });

  it("keeps historical reading in place when an existing card grows", async () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal("ResizeObserver", class {
      public constructor(callback: ResizeObserverCallback) { resize = callback; }
      public observe() {}
      public disconnect() {}
    });
    const wrapper = mount(ChatTimeline, {attachTo: document.body, props: {
      chat: {id: "local", kind: "local", handle: "#local", name: "Local", status: "active", unreadCount: 0},
      messages: [{eventId: "evt_1", createdAt: "2026-09-16T00:00:00.000Z", sender: {kind: "owner", principalId: "prn_owner", handleSnapshot: "owner"}, body: "Task"}],
      activeAgents: []
    }});
    const timeline = wrapper.get(".timeline").element;
    Object.defineProperty(timeline, "scrollHeight", {configurable: true, get: () => 500});
    Object.defineProperty(timeline, "clientHeight", {configurable: true, get: () => 100});
    timeline.scrollTop = 120;
    await wrapper.get(".timeline").trigger("scroll");
    resize?.([{contentRect: {height: 120}} as ResizeObserverEntry], {} as ResizeObserver);
    resize?.([{contentRect: {height: 180}} as ResizeObserverEntry], {} as ResizeObserver);
    await wrapper.vm.$nextTick();
    expect(timeline.scrollTop).toBe(120);
    expect(wrapper.find(".new-content-button").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders a pending local send even before the first persisted message arrives", () => {
    const wrapper = mount(ChatTimeline, {props: {
      chat: {id: "local", kind: "local", handle: "#local", name: "Local", status: "active", unreadCount: 0},
      messages: [], activeAgents: [],
      pendingMessage: {eventId: "pending-local-message", createdAt: "2026-09-16T00:00:00.000Z", body: "First message"}
    }});
    expect(wrapper.find(".pending-message").text()).toContain("First message");
    expect(wrapper.find(".pending-message").text()).toContain("Sending…");
    wrapper.unmount();
  });

  it("renders each Agent proposal as an independently actionable card", async () => {
    const proposals = ["alice", "bob"].map((handle, index) => ({
      schema: "ChatRunProposalView@2" as const,
      proposalId: `chat-proposal:evt_owner:evt_dispatch_${index}`,
      revision: `sha256:${String(index).repeat(64)}`,
      sourceMessageEventId: "evt_owner",
      sourceRootEventId: "evt_owner",
      dispatchEventId: `evt_dispatch_${index}`,
      createdAt: `2026-09-02T04:00:0${index}.000Z`,
      chatLead: { agentId: `prn_${handle}`, handle },
      finalForm: {
        schema: "ChatRunProposalDraft@1" as const,
        goal: `${handle} proposal`,
        scope: { include: [`Run ${handle} approach`], exclude: [] },
        acceptance: [`Verify ${handle} result`],
        desiredEffect: "none" as const
      },
      ready: true,
      runOrchestrator: { agentId: "prn_codex", handle: "codex" },
      participants: [
        { agentId: `prn_${handle}`, handle },
        { agentId: "prn_codex", handle: "codex" }
      ],
      authority: { summary: "workspace=none", maxSteps: 20, maxDepth: 0 }
    }));
    const wrapper = mount(ChatTimeline, {
      props: {
        chat: {
          id: "local",
          kind: "local",
          handle: "#local",
          name: "Local",
          status: "active",
          unreadCount: 0
        },
        messages: [{
          eventId: "evt_owner",
          createdAt: "2026-09-02T03:59:00.000Z",
          sender: {
            kind: "owner",
            principalId: "prn_owner",
            handleSnapshot: "owner"
          },
          body: "Compare approaches.",
          runProposals: proposals
        }],
        activeAgents: [],
        proposalOperations: { [proposals[0]!.proposalId]: "start" }
      }
    });

    expect(wrapper.findAll(".run-proposal")).toHaveLength(2);
    expect(wrapper.text()).toContain("alice proposal");
    expect(wrapper.text()).toContain("bob proposal");
    const actions = wrapper.findAll("button.start-action");
    expect(actions[0]!.attributes("disabled")).toBeDefined();
    expect(actions[1]!.attributes("disabled")).toBeUndefined();
    await actions[1]!.trigger("click");
    expect(wrapper.emitted("confirmProposal")?.[0]?.[0]).toEqual(proposals[1]);
    const declineActions = wrapper.findAll("button.decline-action");
    expect(declineActions).toHaveLength(2);
    expect(declineActions[0]!.attributes("disabled")).toBeDefined();
    expect(declineActions[1]!.attributes("disabled")).toBeUndefined();
    await declineActions[1]!.trigger("click");
    expect(wrapper.emitted("declineProposal")?.[0]?.[0]).toEqual(proposals[1]);
    expect(wrapper.find("button.handoff-action").exists()).toBe(false);
  });
  it("shows native tool work without requiring a proposal and opens its exact Run", async () => {
    const wrapper = mount(ChatTimeline,{props:{
      chat:{id:"local",kind:"local",handle:"#local",name:"Local",status:"active",unreadCount:0},
      messages:[{eventId:"evt_tool",createdAt:"2026-09-10T00:00:00Z",sender:{kind:"owner",principalId:"prn_owner",handleSnapshot:"owner"},body:"研究会话边界",
        works:[{runId:"run_tool",label:"研究会话边界",state:"terminal",status:"cancelled",terminal:true,terminalSummary:"Owner cancelled",outputs:[],updatedAt:"2026-09-10T00:00:01Z"}]}],
      activeAgents:[]
    }});
    expect(wrapper.text()).toContain("Run cancelled");
    expect(wrapper.text()).toContain("Owner cancelled");
    expect(wrapper.find(".run-proposal").exists()).toBe(false);
    await wrapper.get(".chat-work button").trigger("click");
    expect(wrapper.emitted("openRun")?.[0]).toEqual(["run_tool"]);
  });

  it("shows callback state and human attention without adding controls to command or observe work", async () => {
    const wrapper = mount(ChatTimeline, { props: {
      chat: { id: "local", kind: "local", handle: "#local", name: "Local", status: "active", unreadCount: 0 },
      messages: [{
        eventId: "evt_work",
        createdAt: "2026-09-10T00:00:00Z",
        sender: { kind: "owner", principalId: "prn_owner", handleSnapshot: "owner" },
        body: "Run the checks",
        works: [
          {
            kind: "agent",
            detail: { tool: "get_run", runId: "run_agent" },
            runId: "run_agent",
            label: "Agent check",
            state: "needs_human",
            status: "awaiting_orchestrator",
            terminal: false,
            humanQuestion: {
              questionId: "question_1",
              question: "Which environment should I use?",
              runVersion: 4,
              status: "pending",
              expiresAt: "2026-09-11T00:00:00Z"
            },
            returnState: { status: "agent_pending", reason: "Waiting for the Agent turn" },
            outputs: [],
            updatedAt: "2026-09-10T00:00:01Z"
          },
          {
            kind: "command",
            detail: { tool: "get_run", runId: "run_command" },
            runId: "run_command",
            label: "Shell check",
            state: "terminal",
            status: "succeeded",
            terminal: true,
            returnState: { status: "turn_completed" },
            outputs: [],
            updatedAt: "2026-09-10T00:00:01Z"
          },
          {
            kind: "observe",
            detail: { tool: "get_run", runId: "run_observe" },
            runId: "run_observe",
            label: "File observation",
            state: "started",
            status: "running",
            terminal: false,
            returnState: { status: "blocked", reason: "Session is no longer active" },
            outputs: [],
            updatedAt: "2026-09-10T00:00:01Z"
          }
        ]
      }],
      activeAgents: []
    }});

    expect(wrapper.text()).toContain("Waiting for your answer");
    expect(wrapper.text()).toContain("Which environment should I use?");
    expect(wrapper.text()).toContain("Agent pending");
    expect(wrapper.text()).toContain("Agent turn completed · verify task evidence");
    expect(wrapper.text()).toContain("Return: Blocked");
    expect(wrapper.findAll(".chat-work")).toHaveLength(3);
    expect(wrapper.findAll(".open-run-action")).toHaveLength(3);
    expect(wrapper.findAll("button").filter((button) => button.text().includes("Cancel"))).toHaveLength(0);

    await wrapper.findAll(".open-run-action")[1]!.trigger("click");
    expect(wrapper.emitted("openRun")?.[0]).toEqual(["run_command"]);
  });

});
