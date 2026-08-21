import type { IncomingMessage, ServerResponse } from "node:http";

import { grantOwnerWideActivityAccess, revokeOwnerWideActivityAccess } from "../../application/activity/control.js";
import { listAgents } from "../../application/agent/control.js";
import { enrollLocalAgentOnServer } from "../../application/agent/server-control.js";
import { startBrowserDeviceLogin } from "../../application/device/server-control.js";
import { networkSafetyView } from "../../application/network/query.js";
import {
  createServerTopic,
  joinServerTopic,
  listServerTopics,
  publishHumanServerTopicMessage,
  publishServerTopicMessage,
  updateAgentPublicProfile,
  updateServerTopicProfile
} from "../../application/topic/control.js";
import {
  agentPublicProfileUpdateSchema,
  topicCreateRequestSchema,
  topicProfileUpdateSchema
} from "../../protocol.js";
import { json, readJsonBody, requireString } from "./http.js";
import type { UiServerOptions } from "./types.js";

export async function serveNetworkApi(
  options: UiServerOptions,
  deviceLogin: ConsoleDeviceLogin,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const dependencies = {
    ...(options.runtimeDirectory === undefined
      ? {}
      : { runtimeDirectory: options.runtimeDirectory }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  };
  try {
    if (url.pathname === "/api/network" && request.method === "GET") {
      json(response, 200, {
        ...await networkSafetyView(options.repoRoot, {
          ...dependencies,
          ...(options.serverUrl === undefined ? {} : { configuredServerUrl: options.serverUrl })
        }),
        deviceLogin: deviceLogin.snapshot()
      });
      return;
    }
    if (url.pathname === "/api/network/topics" && request.method === "GET") {
      json(response, 200, await listServerTopics(options.repoRoot, dependencies));
      return;
    }
    if (request.headers["x-rollerskate-request"] !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "POST" && url.pathname === "/api/network/device/login") {
      const body = await readJsonBody(request);
      json(response, 202, await deviceLogin.start(
        requireString(body, "serverUrl"),
        body.replaceExisting === true
      ));
      return;
    }
    if (request.method === "POST" && parts.length === 5 && parts[2] === "activity") {
      const handle = parts[3]!;
      if (parts[4] === "grant") {
        json(response, 200, grantOwnerWideActivityAccess(options.repoRoot, handle, dependencies));
        return;
      }
      if (parts[4] === "revoke") {
        revokeOwnerWideActivityAccess(options.repoRoot, handle, dependencies);
        json(response, 200, { status: "not-granted" });
        return;
      }
    }
    if (request.method === "POST" && parts.length === 5 &&
      parts[2] === "agents" && parts[4] === "profile") {
      json(response, 200, await updateAgentPublicProfile(
        options.repoRoot,
        parts[3]!,
        agentPublicProfileUpdateSchema.parse(await readJsonBody(request)),
        dependencies
      ));
      return;
    }
    if (request.method === "POST" && parts.length === 5 &&
      parts[2] === "agents" && parts[4] === "enroll") {
      const handle = parts[3]!;
      const local = listAgents(options.repoRoot, dependencies)
        .find((agent) => agent.handle === handle);
      if (local === undefined) throw new Error(`Local Agent not found: ${handle}`);
      json(response, 200, await enrollLocalAgentOnServer(
        options.repoRoot,
        handle,
        dependencies
      ));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/network/topics/create") {
      json(response, 201, await createServerTopic(
        options.repoRoot,
        topicCreateRequestSchema.parse(await readJsonBody(request)),
        dependencies
      ));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/network/topics/join") {
      const body = await readJsonBody(request);
      json(response, 200, await joinServerTopic(
        options.repoRoot,
        requireString(body, "topicId"),
        requireString(body, "handle"),
        dependencies
      ));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/network/topics/publish") {
      const body = await readJsonBody(request);
      json(response, 201, await publishServerTopicMessage(
        options.repoRoot,
        requireString(body, "topicId"),
        requireString(body, "handle"),
        requireString(body, "transactionId"),
        requireString(body, "message"),
        dependencies
      ));
      return;
    }
    if (request.method === "POST" &&
      url.pathname === "/api/network/topics/human-publish") {
      const body = await readJsonBody(request);
      json(response, 201, await publishHumanServerTopicMessage(
        options.repoRoot,
        requireString(body, "topicId"),
        requireString(body, "transactionId"),
        requireString(body, "message"),
        dependencies
      ));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/network/topics/profile") {
      const body = await readJsonBody(request);
      json(response, 200, await updateServerTopicProfile(
        options.repoRoot,
        requireString(body, "topicId"),
        topicProfileUpdateSchema.parse(body.profile),
        dependencies
      ));
      return;
    }
    json(response, 404, { error: "not_found" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

export type ConsoleDeviceLoginSnapshot =
  | { readonly status: "idle" }
  | {
    readonly status: "pending";
    readonly serverUrl: string;
    readonly verificationUri: string;
    readonly expiresAt: string;
  }
  | { readonly status: "succeeded"; readonly serverUrl: string }
  | { readonly status: "failed"; readonly serverUrl: string; readonly error: string };

export class ConsoleDeviceLogin {
  #state: ConsoleDeviceLoginSnapshot = { status: "idle" };
  #starting = false;

  public constructor(private readonly options: UiServerOptions) {}

  public snapshot(): ConsoleDeviceLoginSnapshot {
    return this.#state;
  }

  public async start(
    serverUrl: string,
    replaceExisting: boolean
  ): Promise<ConsoleDeviceLoginSnapshot> {
    if (this.#starting || this.#state.status === "pending") {
      throw new Error("Device login is already waiting for OIDC approval");
    }
    this.#starting = true;
    try {
      const login = await startBrowserDeviceLogin(this.options.repoRoot, {
        serverUrl,
        replaceExisting
      }, {
        ...(this.options.runtimeDirectory === undefined
          ? {}
          : { runtimeDirectory: this.options.runtimeDirectory }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch })
      });
      this.#state = {
        status: "pending",
        serverUrl,
        verificationUri: login.verificationUri,
        expiresAt: login.expiresAt
      };
      void login.completion.then(() => {
        this.#state = { status: "succeeded", serverUrl };
      }, (error: unknown) => {
        this.#state = {
          status: "failed",
          serverUrl,
          error: error instanceof Error ? error.message : String(error)
        };
      });
      return this.#state;
    } finally {
      this.#starting = false;
    }
  }
}
