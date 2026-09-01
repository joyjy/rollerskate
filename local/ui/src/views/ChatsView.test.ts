import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestJson } from "@/api/client";
import ChatsView from "@/views/ChatsView.vue";

vi.mock("@/api/client", () => ({
  boundedError: (error: unknown) => error instanceof Error ? error.message : String(error),
  requestJson: vi.fn()
}));

const mockedRequestJson = vi.mocked(requestJson);

afterEach(() => vi.useRealTimers());

describe("ChatsView", () => {
  beforeEach(() => {
    mockedRequestJson.mockReset();
    mockedRequestJson.mockImplementation(async (path) => {
      const control = controlResponse(path, []);
      if (control !== undefined) return control;
      if (path === "/api/network/topics") {
        return [{
          id: "top_1",
          name: "public",
          visibility: "public",
          ownerHumanId: "human_1",
          profile: {
            topicId: "top_1",
            purpose: "A visible owner Topic",
            participationRules: [],
            expressionRules: [],
            revision: 1,
            updatedAt: "2026-07-27T00:00:00.000Z"
          },
          createdAt: "2026-07-27T00:00:00.000Z"
        }];
      }
      if (path === "/api/chat/presence") {
        return { topicId: "local_1", agents: [] };
      }
      return {
        chat: { topicId: "local_1", handle: "local" },
        agents: [],
        events: [],
        messages: { topicId: "local_1", items: [], hasEarlier: false },
        sessions: [],
        conversation: conversation()
      };
    });
  });

  it("shows a Human composer without inventing a Human Topic membership", async () => {
    const wrapper = mount(ChatsView);
    await flushPromises();

    const topic = wrapper.findAll("button").find((button) => button.text().includes("#public"));
    expect(topic).toBeDefined();
    await topic!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("This Topic is visible to you even before an Agent joins.");
    expect(wrapper.text()).toContain("No Agents have joined this Topic.");
    expect(wrapper.find("textarea").exists()).toBe(true);
    expect(wrapper.text()).toContain("You speak as Human; only Agents join the Topic.");
    wrapper.unmount();
  });

  it("keeps Chat history visible while a failed presence query retries", async () => {
    vi.useFakeTimers();
    let presenceRequests = 0;
    let rejectRetry!: (reason: unknown) => void;
    const retry = new Promise<never>((_resolve, reject) => {
      rejectRetry = reject;
    });
    mockedRequestJson.mockImplementation(async (path) => {
      const control = controlResponse(path, []);
      if (control !== undefined) return control;
      if (path === "/api/chat/presence") {
        presenceRequests += 1;
        if (presenceRequests === 1) throw new Error("Presence unavailable");
        return retry;
      }
      if (path === "/api/network/topics") return [];
      if (path === "/api/network") return networkView(false, false);
      return {
        chat: { topicId: "local_1", handle: "local" },
        agents: [],
        events: [],
        messages: { topicId: "local_1", items: [], hasEarlier: false },
        sessions: [],
        conversation: conversation()
      };
    });
    const wrapper = mount(ChatsView);
    await flushPromises();

    expect(wrapper.find(".chats-layout").exists()).toBe(true);
    expect(wrapper.text()).toContain("Presence unavailable");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(presenceRequests).toBe(2);
    expect(wrapper.find(".chats-layout").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("Loading immutable Chat history");

    rejectRetry(new Error("Presence still unavailable"));
    await flushPromises();
    wrapper.unmount();
  });

  it("renders Human and Agent history and preserves a failed Human publish for retry", async () => {
    const publishCalls: Array<{ transactionId: string; message: string }> = [];
    let attempts = 0;
    mockedRequestJson.mockImplementation(async (path, _schema, options) => {
      const control = controlResponse(path, []);
      if (control !== undefined) return control;
      if (path === "/api/network/topics") {
        return [{
          id: "top_1",
          name: "public",
          visibility: "public",
          ownerHumanId: "human_1",
          profile: {
            topicId: "top_1",
            purpose: "A visible owner Topic",
            participationRules: [],
            expressionRules: [],
            revision: 1,
            updatedAt: "2026-07-27T00:00:00.000Z"
          },
          createdAt: "2026-07-27T00:00:00.000Z"
        }];
      }
      if (path === "/api/network/topics/human-publish" && options?.method === "POST") {
        const body = JSON.parse(String(options.body)) as {
          transactionId: string;
          message: string;
        };
        publishCalls.push(body);
        attempts += 1;
        if (attempts === 1) throw new Error("Server unavailable");
        return { eventId: "human_event_2" };
      }
      if (path === "/api/network") return networkView(true, true, topicEvents());
      if (path === "/api/chat/presence") return { topicId: "local_1", agents: [] };
      return {
        chat: { topicId: "local_1", handle: "local" },
        agents: [],
        events: [],
        messages: { topicId: "local_1", items: [], hasEarlier: false },
        sessions: [],
        conversation: conversation()
      };
    });
    const wrapper = mount(ChatsView);
    await flushPromises();
    const topic = wrapper.findAll("button").find((button) => button.text().includes("#public"));
    await topic!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Owner · You");
    expect(wrapper.text()).toContain("@alice");
    const textarea = wrapper.get("textarea");
    await textarea.setValue("Can you check this?");
    const send = () => wrapper.findAll("button").find((button) => button.text() === "Send")!;
    await send().trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Your draft is preserved");
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value)
      .toBe("Can you check this?");

    await send().trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Sent as Human");
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("");
    expect(publishCalls).toHaveLength(2);
    expect(publishCalls[1]?.transactionId).toBe(publishCalls[0]?.transactionId);
    wrapper.unmount();
  });

  it("enrolls and joins a Local Agent from the Topic Agents panel", async () => {
    let enrolled = false;
    let joined = false;
    mockedRequestJson.mockImplementation(async (path, _schema, options) => {
      const control = controlResponse(path, []);
      if (control !== undefined) return control;
      if (path === "/api/network/topics") {
        return [{
          id: "top_1",
          name: "public",
          visibility: "public",
          ownerHumanId: "human_1",
          profile: {
            topicId: "top_1",
            purpose: "A visible owner Topic",
            participationRules: [],
            expressionRules: [],
            revision: 1,
            updatedAt: "2026-07-27T00:00:00.000Z"
          },
          createdAt: "2026-07-27T00:00:00.000Z"
        }];
      }
      if (path === "/api/network/agents/alice/enroll" && options?.method === "POST") {
        enrolled = true;
        return { status: "active" };
      }
      if (path === "/api/network/topics/join" && options?.method === "POST") {
        joined = true;
        return { status: "active" };
      }
      if (path === "/api/network") return networkView(enrolled, joined);
      if (path === "/api/chat/presence") return { topicId: "local_1", agents: [] };
      return {
        chat: { topicId: "local_1", handle: "local" },
        agents: [],
        events: [],
        messages: { topicId: "local_1", items: [], hasEarlier: false },
        sessions: [],
        conversation: conversation()
      };
    });
    const wrapper = mount(ChatsView);
    await flushPromises();

    const topic = wrapper.findAll("button").find((button) => button.text().includes("#public"));
    await topic!.trigger("click");
    await flushPromises();
    await wrapper.get("button[aria-label='Add Agent to Topic']").trigger("click");
    expect(wrapper.text()).toContain("Owner / Test Mac / @alice");

    const option = wrapper.findAll("button").find((button) => button.text().includes("Enroll & join"));
    await option!.trigger("click");
    await flushPromises();

    expect(mockedRequestJson.mock.calls.some(([path, , call]) =>
      path === "/api/network/agents/alice/enroll" && call?.method === "POST")).toBe(true);
    expect(mockedRequestJson.mock.calls.some(([path, , call]) =>
      path === "/api/network/topics/join" && call?.method === "POST" &&
      JSON.parse(String(call.body)).topicId === "top_1")).toBe(true);
    expect(wrapper.text()).toContain("Joined");
    wrapper.unmount();
  });

  it("starts an empty Topic, keeps Wake separate, and controls same-client history", async () => {
    const agent = localAgent();
    mockedRequestJson.mockImplementation(async (path, _schema, options) => {
      const control = controlResponse(path, [agent.principalId]);
      if (control !== undefined) return control;
      if (options?.method === "POST") return {};
      if (path === "/api/network/topics") return [];
      if (path === "/api/network") return networkView(false, false);
      if (path === "/api/chat/presence") {
        return {
          topicId: "local_1",
          agents: [{
            principalId: agent.principalId,
            handle: agent.handle,
            status: "active"
          }]
        };
      }
      if (path === "/api/chat") {
        return {
          chat: { topicId: "local_1", handle: "local" },
          agents: [agent],
          events: [],
          messages: { topicId: "local_1", items: [], hasEarlier: false },
          sessions: [{ principalId: agent.principalId, generation: 1 }],
          conversation: conversation()
        };
      }
      return {};
    });
    const wrapper = mount(ChatsView);
    await flushPromises();

    const activationCalls = () => mockedRequestJson.mock.calls.filter(([path, , call]) =>
      path === "/api/chat/activate" && call?.method === "POST");
    expect(activationCalls()).toHaveLength(1);
    expect(JSON.parse(String(activationCalls()[0]![2]?.body)).strategy).toBe("starter");
    expect(wrapper.text()).toContain("Ready to start");
    expect(wrapper.text()).toContain("8 of 8 turns left");
    expect(wrapper.text()).not.toContain("prn_1");

    await wrapper.get("select[aria-label='Conversation intent']").setValue("directed");
    await wrapper.get("input[aria-label='Conversation brief']").setValue("Review release risk.");
    const wake = wrapper.findAll("button").find((button) => button.text() === "Wake now");
    await wake!.trigger("click");
    await flushPromises();
    expect(activationCalls()).toHaveLength(2);
    expect(JSON.parse(String(activationCalls()[1]![2]?.body))).toMatchObject({
      strategy: "manual",
      intent: "directed",
      brief: "Review release risk."
    });

    const allow = wrapper.findAll("button").find((button) => button.text() === "Allow");
    await allow!.trigger("click");
    await flushPromises();
    const historyCall = mockedRequestJson.mock.calls.find(([path, , call]) =>
      path === "/api/chat/agents/prn_1/history-access" && call?.method === "POST");
    expect(JSON.parse(String(historyCall?.[2]?.body))).toEqual({ action: "grant" });
    expect(wrapper.text()).toContain("Codex");
    expect(wrapper.text()).toContain("Client history");
    wrapper.unmount();
  });

  it("explains the active speaker, last turn, and bounded history coverage", async () => {
    const agent = localAgent();
    mockedRequestJson.mockImplementation(async (path) => {
      const control = controlResponse(path, [agent.principalId]);
      if (control !== undefined) return control;
      if (path === "/api/network/topics") return [];
      if (path === "/api/network") return networkView(false, false);
      if (path === "/api/chat/presence") {
        return {
          topicId: "local_1",
          agents: [{
            principalId: agent.principalId,
            handle: agent.handle,
            status: "active",
            lastTurn: { state: "thinking", at: "2026-07-31T00:00:00.000Z" },
            clientHistory: {
              client: "codex",
              status: "active",
              updatedAt: "2026-07-31T00:00:00.000Z",
              coverage: "available",
              lastResultCount: 2,
              truncated: true
            }
          }]
        };
      }
      return {
        chat: { topicId: "local_1", handle: "local" },
        agents: [agent],
        events: [],
        messages: { topicId: "local_1", items: [], hasEarlier: false },
        sessions: [{ principalId: agent.principalId, generation: 1 }],
        conversation: {
          ...conversation(),
          state: "active",
          activeSpeakerHandle: "alice",
          activeSpeakerHandles: ["alice"]
        }
      };
    });
    const wrapper = mount(ChatsView);
    await flushPromises();

    expect(wrapper.text()).toContain("@alice is thinking");
    expect(wrapper.text()).toContain("Thinking now");
    expect(wrapper.text()).toContain("Available · bounded result · 2 results");
    wrapper.unmount();
  });

  it("routes Topic, participant, Free Chat and schedule controls through canonical APIs", async () => {
    const agent = localAgent();
    mockedRequestJson.mockImplementation(async (path, _schema, options) => {
      if (options?.method === "POST") return {};
      const control = controlResponse(path, [agent.principalId]);
      if (control !== undefined) return control;
      if (path === "/api/network/topics") return [];
      if (path === "/api/network") return networkView(false, false);
      if (path === "/api/chat/presence") {
        return { topicId: "local_1", agents: [] };
      }
      return {
        chat: { topicId: "local_1", handle: "local" },
        agents: [agent],
        events: [],
        messages: { topicId: "local_1", items: [], hasEarlier: false },
        sessions: [],
        conversation: { ...conversation(), state: "idle" }
      };
    });
    const wrapper = mount(ChatsView);
    await flushPromises();

    await wrapper.findAll("button").find((button) => button.text() === "Pause Topic")!
      .trigger("click");
    await flushPromises();
    await wrapper.findAll("button").find((button) => button.text() === "Remove")!
      .trigger("click");
    await flushPromises();
    await wrapper.findAll("button").find((button) => button.text() === "Start Free Chat")!
      .trigger("click");
    await flushPromises();

    const calls = mockedRequestJson.mock.calls;
    expect(postBody(calls, "/api/chat/governance/pause")).toEqual({ expectedRevision: 1 });
    expect(postBody(calls, "/api/chat/governance/participants/prn_1/remove"))
      .toEqual({ expectedRevision: 1 });
    expect(postBody(calls, "/api/chat/free-chat/start")).toMatchObject({
      intent: "continue_recent"
    });
    wrapper.unmount();
  });

  it("replies to a Local message with an explicit reference", async () => {
    const agent = localAgent();
    let postedBody: Record<string, unknown> | undefined;
    mockedRequestJson.mockImplementation(async (path, _schema, options) => {
      if (path === "/api/chat/messages" && options?.method === "POST") {
        postedBody = JSON.parse(String(options.body)) as Record<string, unknown>;
        return {};
      }
      const control = controlResponse(path, [agent.principalId]);
      if (control !== undefined) return control;
      if (path === "/api/network/topics") return [];
      if (path === "/api/network") return networkView(false, false);
      if (path === "/api/chat/presence") {
        return { topicId: "local_1", agents: [] };
      }
      return {
        chat: { topicId: "local_1", handle: "local" },
        agents: [agent],
        events: [],
        messages: {
          topicId: "local_1",
          items: [{
            eventId: "evt_agent_reply",
            createdAt: "2026-08-19T00:00:00.000Z",
            sender: {
              kind: "agent",
              principalId: agent.principalId,
              handleSnapshot: agent.handle
            },
            body: "This is the claim to reference."
          }],
          hasEarlier: false
        },
        sessions: [],
        conversation: { ...conversation(), state: "idle" }
      };
    });
    const wrapper = mount(ChatsView);
    await flushPromises();

    await wrapper.get("button.reply-action").trigger("click");
    expect(wrapper.text()).toContain("Replying to alice");
    expect(wrapper.text()).toContain("This is the claim to reference.");
    await wrapper.get("textarea").setValue("I mean this specific point.");
    await wrapper.findAll("button").find((button) => button.text() === "Send")!.trigger("click");
    await flushPromises();

    expect(postedBody).toEqual({
      body: "I mean this specific point.",
      replyToEventId: "evt_agent_reply"
    });
    expect(wrapper.find(".reply-preview").exists()).toBe(false);
    wrapper.unmount();
  });
});

function controlResponse(path: RequestInfo | URL, participantAgentIds: readonly string[]) {
  if (path === "/api/chat/governance") {
    return {
      governance: {
        topicId: "local_1",
        status: "active",
        participants: participantAgentIds.map((agentId) => ({
          agentId,
          status: "active",
          joinedAt: "2026-07-31T00:00:00.000Z",
          governanceRevision: 1
        })),
        strategyPolicy: {
          starterEnabled: true,
          participantMessageEnabled: true,
          scheduledEnabled: true
        },
        conversationPolicy: { defaultIntent: "continue_recent", themes: [] },
        revision: 1,
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z"
      },
      activeParticipantAgentIds: participantAgentIds,
      recentReceipts: [],
      actionAvailability: {
        expectedRevision: 1,
        pause: true,
        resume: false,
        resumeAndWake: false,
        participantAddAgentIds: [],
        participantRemoveAgentIds: participantAgentIds
      }
    };
  }
  if (path === "/api/chat/free-chat") {
    return {
      recentReceipts: [],
      actionAvailability: { start: participantAgentIds.length > 0, continueNow: false, exit: false }
    };
  }
  if (path === "/api/chat/schedules") return [];
  return undefined;
}

function postBody(
  calls: Parameters<typeof mockedRequestJson>[0] extends never ? never : typeof mockedRequestJson.mock.calls,
  path: string
) {
  const call = calls.find(([candidate, , options]) =>
    candidate === path && options?.method === "POST");
  return JSON.parse(String(call?.[2]?.body));
}

function conversation() {
  return {
    strategy: "starter",
    state: "starter_pending",
    turnBudget: 8,
    usedTurns: 0,
    remainingTurns: 8,
    activeSpeakerHandles: []
  };
}

function localAgent() {
  return {
    principalId: "prn_1",
    handle: "alice",
    status: "active" as const,
    client: "codex" as const,
    executionConfig: { launchArgs: [] },
    availability: { state: "ready" as const },
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z"
  };
}

function networkView(enrolled: boolean, joined: boolean, events: readonly object[] = []) {
  return {
    deviceLogin: { status: "succeeded", serverUrl: "http://127.0.0.1:4100" },
    device: {
      hasCredential: true,
      metadata: {
        deviceId: "dev_1",
        deviceName: "Test Mac",
        serverUrl: "http://127.0.0.1:4100",
        status: "active",
        humanId: "human_1",
        humanDisplayName: "Owner"
      }
    },
    agents: [{
      agent: {
        principalId: "prn_1",
        handle: "alice",
        status: "active",
        client: "codex",
        executionConfig: { launchArgs: [] },
        availability: { state: "ready" },
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      },
      activityAccess: null,
      ...(enrolled ? {
        serverAgent: {
          credentialId: "cred_1",
          deviceId: "dev_1",
          placementId: "plc_1",
          summary: {
            id: "agt_1",
            name: "alice",
            status: "active",
            credentialStatus: "active",
            owner: { id: "human_1", displayName: "Owner" },
            placement: { id: "plc_1", deviceId: "dev_1", state: "active" }
          }
        }
      } : {})
    }],
    topics: [{
      topic: {
        id: "top_1",
        name: "#public",
        visibility: "public",
        profile: {
          purpose: "A visible owner Topic",
          participationRules: [],
          expressionRules: [],
          revision: 1
        }
      },
      cursor: 0,
      syncedAt: "2026-07-27T00:00:00.000Z",
      participants: joined ? [{
        localAgentId: "prn_1",
        serverAgentId: "agt_1",
        profile: {
          agentId: "agt_1",
          displayName: "Alice",
          role: "Collaborator",
          disclosure: "Automated Agent",
          expressionRules: [],
          revision: 1,
          updatedAt: "2026-07-27T00:00:00.000Z"
        }
      }] : [],
      events
    }]
  };
}

function topicEvents() {
  return [{
    eventId: "human_event_1",
    publisher: {
      kind: "human",
      humanId: "human_1",
      displayName: "Owner",
      deviceId: "dev_1"
    },
    body: "Please investigate.",
    createdAt: "2026-07-27T00:00:01.000Z"
  }, {
    eventId: "agent_event_1",
    publisher: {
      kind: "agent",
      agentId: "agt_1",
      agentName: "alice",
      ownerHumanId: "human_1",
      ownerDisplayName: "Owner",
      deviceId: "dev_1"
    },
    body: "I am checking it.",
    createdAt: "2026-07-27T00:00:02.000Z"
  }];
}
