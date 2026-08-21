import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestJson } from "@/api/client";
import NetworkView from "@/views/NetworkView.vue";

vi.mock("@/api/client", () => ({
  boundedError: (error: unknown) => error instanceof Error ? error.message : String(error),
  requestJson: vi.fn()
}));

const mockedRequestJson = vi.mocked(requestJson);

describe("NetworkView", () => {
  beforeEach(() => {
    mockedRequestJson.mockReset();
  });

  it("keeps a dirty profile draft when a newer poll snapshot arrives", async () => {
    let revision = 1;
    mockedRequestJson.mockImplementation(async (path) => {
      if (path === "/api/network/topics") return serverTopics();
      return networkView(revision === 1 ? "Server profile" : "Externally updated", revision++);
    });
    const wrapper = mount(NetworkView);
    await flushPromises();

    const displayName = input(wrapper, "Display name");
    await displayName.setValue("Local draft");
    await button(wrapper, "Refresh").trigger("click");
    await flushPromises();

    expect((displayName.element as HTMLInputElement).value).toBe("Local draft");
    expect(wrapper.text()).toContain("Revision 1 · unsaved");
    wrapper.unmount();
  });

  it("submits the draft revision and adopts the refreshed profile after success", async () => {
    mockedRequestJson.mockImplementation(async (_path, _schema, options) => {
      if (_path === "/api/network/topics") return serverTopics();
      if (options?.method === "POST") return { status: "ok" };
      return mockedRequestJson.mock.calls.some(([, , call]) => call?.method === "POST")
        ? networkView("Local draft", 2)
        : networkView("Server profile", 1);
    });
    const wrapper = mount(NetworkView);
    await flushPromises();

    await input(wrapper, "Display name").setValue("Local draft");
    await button(wrapper, "Save profile").trigger("click");
    await flushPromises();

    const post = mockedRequestJson.mock.calls.find(([, , options]) => options?.method === "POST");
    expect(JSON.parse(String(post?.[2]?.body))).toMatchObject({
      displayName: "Local draft",
      expectedRevision: 1
    });
    expect(wrapper.text()).toContain("Revision 2");
    expect(wrapper.text()).not.toContain("unsaved");
    wrapper.unmount();
  });

  it("reuses the publish transaction id after an ambiguous failure", async () => {
    let publishAttempts = 0;
    mockedRequestJson.mockImplementation(async (path, _schema, options) => {
      if (path === "/api/network/topics" && options?.method !== "POST") return serverTopics();
      if (path === "/api/network/topics/publish" && options?.method === "POST") {
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error("connection lost");
        return { status: "ok" };
      }
      return networkView("Server profile", 1);
    });
    const wrapper = mount(NetworkView);
    await flushPromises();

    await select(wrapper, "Publish to").setValue("top_1");
    const textareas = wrapper.findAll("textarea");
    await textareas[2]!.setValue("Finding");
    await button(wrapper, "Publish once").trigger("click");
    await flushPromises();
    await button(wrapper, "Publish once").trigger("click");
    await flushPromises();

    const attempts = mockedRequestJson.mock.calls
      .filter(([path, , options]) => path === "/api/network/topics/publish" &&
        options?.method === "POST")
      .map(([, , options]) => JSON.parse(String(options?.body)) as { transactionId: string });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.transactionId).toBe(attempts[1]!.transactionId);
    wrapper.unmount();
  });

  it("starts browser OIDC login locally and opens the Server pairing URL", async () => {
    const replace = vi.fn();
    const signInWindow = {
      opener: window,
      location: { replace },
      close: vi.fn()
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockImplementation(() => signInWindow);
    mockedRequestJson.mockImplementation(async (path, _schema, options) => {
      if (path === "/api/network/topics") return serverTopics();
      if (path === "/api/network/device/login" && options?.method === "POST") {
        return {
          status: "pending",
          serverUrl: "http://127.0.0.1:4100",
          verificationUri: "http://127.0.0.1:4100/device/pair/pairing-id",
          expiresAt: "2099-01-01T00:00:00.000Z"
        };
      }
      return networkView("Server profile", 1);
    });
    const wrapper = mount(NetworkView);
    await flushPromises();

    await button(wrapper, "Reconnect Server").trigger("click");
    await flushPromises();

    const post = mockedRequestJson.mock.calls.find(([path]) =>
      path === "/api/network/device/login");
    expect(JSON.parse(String(post?.[2]?.body))).toEqual({
      serverUrl: "http://127.0.0.1:4100",
      replaceExisting: true
    });
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(signInWindow.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith(
      "http://127.0.0.1:4100/device/pair/pairing-id"
    );
    expect(wrapper.text()).toContain("Waiting for browser sign-in and device approval");
    open.mockRestore();
    wrapper.unmount();
  });

  it("enrolls an existing Local Agent and exposes its Server namespace", async () => {
    let enrolled = false;
    mockedRequestJson.mockImplementation(async (path, _schema, options) => {
      if (path === "/api/network/topics") return serverTopics();
      if (path === "/api/network/agents/alice/enroll" && options?.method === "POST") {
        enrolled = true;
        return { status: "active" };
      }
      return networkView("alice", 0, enrolled);
    });
    const wrapper = mount(NetworkView);
    await flushPromises();

    expect(wrapper.text()).toContain("Local only");
    await button(wrapper, "Enroll / recover Server identity").trigger("click");
    await flushPromises();

    expect(mockedRequestJson.mock.calls.some(([path, , options]) =>
      path === "/api/network/agents/alice/enroll" && options?.method === "POST")).toBe(true);
    expect(wrapper.text()).toContain("Alice / Test laptop / @alice");
    expect(wrapper.text()).toContain("Server active");
    wrapper.unmount();
  });
});

function button(wrapper: ReturnType<typeof mount>, label: string) {
  const candidate = wrapper.findAll("button").find((entry) => entry.text() === label);
  if (candidate === undefined) throw new Error(`Button not found: ${label}`);
  return candidate;
}

function input(wrapper: ReturnType<typeof mount>, label: string) {
  const candidate = wrapper.findAll("label").find((entry) => entry.text().startsWith(label));
  if (candidate === undefined) throw new Error(`Input not found: ${label}`);
  return candidate.get("input");
}

function select(wrapper: ReturnType<typeof mount>, label: string) {
  const candidate = wrapper.findAll("label").find((entry) => entry.text().startsWith(label));
  if (candidate === undefined) throw new Error(`Select not found: ${label}`);
  return candidate.get("select");
}

function networkView(displayName: string, revision: number, enrolled = true) {
  return {
    configuredServerUrl: "http://127.0.0.1:4100",
    deviceLogin: { status: "idle" },
    device: {
      hasCredential: true,
      metadata: {
        deviceId: "dev_1",
        deviceName: "Test laptop",
        serverUrl: "http://127.0.0.1:7777",
        status: "active"
      }
    },
    agents: [{
      agent: {
        principalId: "prn_1",
        handle: "alice",
        client: "codex",
        status: "active",
        executionConfig: { launchArgs: [] },
        availability: { state: "ready" },
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      },
      activityAccess: null,
      ...(enrolled ? { serverAgent: {
        credentialId: "cred_1",
        deviceId: "dev_1",
        placementId: "plc_1",
        summary: {
          id: "agt_1",
          name: "alice",
          status: "active",
          credentialStatus: "active",
          owner: { id: "hum_1", displayName: "Alice" },
          placement: { id: "plc_1", deviceId: "dev_1", state: "active" }
        }
      } } : { serverAgentError: "Agent alice does not have an active Server credential" }),
      ...(enrolled ? { profile: {
        agentId: "agt_1",
        displayName,
        role: "Researcher",
        disclosure: "Automated Agent",
        expressionRules: ["Label uncertainty."],
        revision,
        updatedAt: "2026-07-27T00:00:00.000Z"
      } } : {})
    }],
    topics: []
  };
}

function serverTopics() {
  return [{
    id: "top_1",
    name: "public",
    visibility: "public",
    ownerHumanId: "hum_1",
    profile: {
      topicId: "top_1",
      purpose: "Free chat",
      participationRules: [],
      expressionRules: [],
      revision: 1,
      updatedAt: "2026-07-27T00:00:00.000Z"
    },
    createdAt: "2026-07-27T00:00:00.000Z"
  }];
}
