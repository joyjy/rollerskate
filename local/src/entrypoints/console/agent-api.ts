import type { IncomingMessage, ServerResponse } from "node:http";

import {
  addLocalAgent,
  configureLocalAgent,
  inspectAgent,
  isAgentClient,
  listAgents,
  localRuntimeSnapshot,
  renameLocalAgent,
  resumeLocalAgent,
  suspendLocalAgent
} from "../../application/agent/control.js";
import type { ConsoleRequestMarker } from "./http.js";
import {
  json,
  optionalStringArray,
  readJsonBody,
  requireString
} from "./http.js";

export async function serveAgentApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  request: IncomingMessage,
  requestMarker: ConsoleRequestMarker,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const options = runtimeDirectory === undefined ? {} : { runtimeDirectory };
  try {
    if (url.pathname === "/api/local" && method === "GET") {
      json(response, 200, localRuntimeSnapshot(repoRoot, options));
      return;
    }
    if (url.pathname === "/api/agents" && method === "GET") {
      json(response, 200, listAgents(repoRoot, options));
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (method === "GET" && parts.length === 3 && parts[1] === "agents") {
      json(response, 200, inspectAgent(repoRoot, parts[2]!, options));
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    if (url.pathname === "/api/agents" && method === "POST") {
      const body = await readJsonBody(request);
      const client = requireString(body, "client");
      if (!isAgentClient(client)) {
        throw new Error("client must be codex, claude-code, kimi-code or pi");
      }
      const agent = addLocalAgent(
        repoRoot,
        requireString(body, "handle"),
        client,
        options,
        optionalStringArray(body, "launchArgs")
      );
      json(response, 201, inspectAgent(repoRoot, agent.principalId, options));
      return;
    }
    const principalId = parts[2];
    const action = parts[3];
    if (method === "POST" && principalId !== undefined && action !== undefined &&
      parts.length === 4) {
      if (action === "rename") {
        const body = await readJsonBody(request);
        renameLocalAgent(
          repoRoot,
          principalId,
          requireString(body, "handle"),
          options
        );
        json(response, 200, inspectAgent(repoRoot, principalId, options));
        return;
      }
      if (action === "configure") {
        const body = await readJsonBody(request);
        configureLocalAgent(
          repoRoot,
          principalId,
          optionalStringArray(body, "launchArgs"),
          options
        );
        json(response, 200, inspectAgent(repoRoot, principalId, options));
        return;
      }
      if (action === "suspend") {
        suspendLocalAgent(repoRoot, principalId, options);
        json(response, 200, inspectAgent(repoRoot, principalId, options));
        return;
      }
      if (action === "resume") {
        resumeLocalAgent(repoRoot, principalId, options);
        json(response, 200, inspectAgent(repoRoot, principalId, options));
        return;
      }
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}
