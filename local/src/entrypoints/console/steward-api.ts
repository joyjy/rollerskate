import { inspectChatRunRecovery, confirmChatRunRecovery, requestChatRunRecovery } from "../../application/chat/run-recovery.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  retryStewardOrchestrator,
  cancelStewardRun,
  closeStewardRunSeries,
  setStewardRunArchived,
  submitCallerRunDecision
} from "../../application/steward/control.js";
import { answerStewardRunFromConsole } from "../../application/chat/human-control.js";
import { authorizeRunNetwork } from "../../application/steward/capability.js";
import { startStewardRunFromIntent } from
  "../../application/steward/intent-control.js";
import {
  latestStewardRunView,
  pageStewardRunViews
} from "../../application/steward/query.js";
import { inspectRun } from "../../application/run/query.js";
import type { ConsoleRequestMarker } from "./http.js";
import {
  json,
  parseListPageQuery,
  readJsonBody,
  requireString
} from "./http.js";

export async function serveStewardApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  request: IncomingMessage,
  requestMarker: ConsoleRequestMarker,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 2 && method === "GET") {
      json(response, 200, pageStewardRunViews(
        repoRoot,
        parseListPageQuery(url),
        runtimeDirectory
      ));
      return;
    }
    if (parts.length === 2 && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const body = await readJsonBody(request);
      json(response, 200, startStewardRunFromIntent(
        repoRoot,
        body,
        runtimeDirectory
      ));
      return;
    }
    if (parts.length === 3 && parts[2] === "latest") {
      if (method !== "GET") {
        json(response, 405, { error: "method_not_allowed" });
        return;
      }
      json(response, 200, latestStewardRunView(repoRoot, runtimeDirectory));
      return;
    }
    const runId = parts[2];
    if (runId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, inspectRun(repoRoot, runId, runtimeDirectory));
      return;
    }
    if (parts.length === 4 && parts[3] === "cancel" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const body = await readJsonBody(request);
      json(response, 200, cancelStewardRun(
        repoRoot, runId, runtimeDirectory, undefined,
        expectedVersion(body)
      ));
      return;
    }
    if (parts.length === 4 && parts[3] === "answer" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const body = await readJsonBody(request);
      json(response, 200, answerStewardRunFromConsole(
        repoRoot, runId, requireString(body, "questionId"),
        expectedVersion(body), requireString(body, "answer"), runtimeDirectory
      ));
      return;
    }
    if (parts.length === 4 && parts[3] === "authorize-network" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const body = await readJsonBody(request);
      json(response, 200, authorizeRunNetwork(
        repoRoot, runId, requireString(body, "requestEventId"),
        expectedVersion(body), runtimeDirectory
      ));
      return;
    }
    if (parts.length === 4 && parts[3] === "close" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const body = await readJsonBody(request);
      json(response, 200, closeStewardRunSeries(
        repoRoot,
        runId,
        requireString(body, "summary"),
        runtimeDirectory
      ));
      return;
    }
    if (parts.length === 4 &&
      (parts[3] === "archive" || parts[3] === "unarchive") && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      json(response, 200, setStewardRunArchived(
        repoRoot,
        runId,
        parts[3] === "archive",
        runtimeDirectory
      ));
      return;
    }
    if (parts.length === 4 && parts[3] === "recovery" && method === "GET") {
      json(response, 200, inspectChatRunRecovery(repoRoot, runId, runtimeDirectory));
      return;
    }
    if (parts.length === 4 && parts[3] === "request-recovery" && method === "POST") {
      if (requestMarker !== "console") { json(response, 403, {error: "console_request_marker_required"}); return; }
      const body = await readJsonBody(request);
      json(response, 200, requestChatRunRecovery(repoRoot, runId, requireString(body, "requestId"), runtimeDirectory));
      return;
    }
    if (parts.length === 4 && parts[3] === "confirm-recovery" && method === "POST") {
      if (requestMarker !== "console") { json(response, 403, {error: "console_request_marker_required"}); return; }
      const body = await readJsonBody(request);
      json(response, 200, confirmChatRunRecovery(repoRoot, runId, requireString(body, "revision"), runtimeDirectory));
      return;
    }
    if (parts.length === 4 && parts[3] === "retry-orchestrator" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const body = await readJsonBody(request);
      json(response, 200, retryStewardOrchestrator(repoRoot, runId, requireString(body, "requestId"), runtimeDirectory, undefined, expectedVersion(body)));
      return;
    }
    if (parts.length === 4 && parts[3] === "decide" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const body = await readJsonBody(request);
      const decision = body.decision;
      if (typeof decision !== "object" || decision === null || Array.isArray(decision)) {
        throw new Error("decision must be an object");
      }
      json(response, 200, submitCallerRunDecision(
        repoRoot,
        runId,
        {
          requestId: requireString(body, "requestId"),
          decision: decision as Readonly<Record<string, unknown>>
        },
        runtimeDirectory
      ));
      return;
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function expectedVersion(body: Record<string, unknown>): number {
  const value = body.expectedVersion;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("expectedVersion must be a positive integer");
  }
  return value;
}
