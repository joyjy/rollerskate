import type { IncomingMessage, ServerResponse } from "node:http";

import {
  controlSchedule,
  inspectSchedule,
  resolveUnknownScheduledRun,
  runScheduleNow
} from "../../application/schedule/control.js";
import {
  inspectScheduleView,
  listScheduledRunViews,
  listScheduleViews,
  scheduleDetailView,
  scheduledRunView,
  traceScheduledRunView
} from "../../application/schedule/query.js";
import type { ConsoleRequestMarker } from "./http.js";
import {
  json,
  parseBoundedQueryInteger,
  readJsonBody,
  requireString
} from "./http.js";

export async function serveScheduleApi(
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
      json(response, 200, listScheduleViews(repoRoot, runtimeDirectory));
      return;
    }
    const scheduleId = parts[2];
    if (scheduleId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, inspectScheduleView(repoRoot, scheduleId, runtimeDirectory));
      return;
    }
    if (parts.length === 4 && parts[3] === "runs" && method === "GET") {
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? 100
        : parseBoundedQueryInteger(limitValue, "scheduled run limit", 1, 200);
      json(response, 200, listScheduledRunViews(
        repoRoot,
        scheduleId,
        runtimeDirectory,
        limit
      ));
      return;
    }
    const runId = parts[4];
    if (parts.length === 5 && parts[3] === "runs" && runId !== undefined &&
      method === "GET") {
      const run = traceScheduledRunView(repoRoot, runId, runtimeDirectory);
      if (run.scheduleId !== scheduleId) throw new Error("run does not belong to Schedule");
      json(response, 200, run);
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    const action = parts[3];
    if (parts.length === 4 && method === "POST" &&
      (action === "pause" || action === "resume" || action === "cancel")) {
      json(response, 200, scheduleDetailView(
        controlSchedule(repoRoot, scheduleId, action, runtimeDirectory)
      ));
      return;
    }
    if (parts.length === 4 && method === "POST" && action === "run-now") {
      const body = await readJsonBody(request);
      const receipt = runScheduleNow(
        repoRoot,
        scheduleId,
        requireString(body, "requestId"),
        runtimeDirectory
      );
      json(response, 200, {
        receipt,
        schedule: inspectScheduleView(repoRoot, scheduleId, runtimeDirectory)
      });
      return;
    }
    if (parts.length === 6 && parts[3] === "runs" && runId !== undefined &&
      parts[5] === "resolve" && method === "POST") {
      const body = await readJsonBody(request);
      const outcome = requireString(body, "outcome");
      if (outcome !== "succeeded" && outcome !== "failed") {
        throw new Error("outcome must be succeeded or failed");
      }
      const run = resolveUnknownScheduledRun(
        repoRoot,
        runId,
        outcome,
        runtimeDirectory
      );
      if (run.run.scheduleId !== scheduleId) {
        throw new Error("run does not belong to Schedule");
      }
      json(response, 200, {
        run: scheduledRunView(run),
        schedule: scheduleDetailView(
          inspectSchedule(repoRoot, scheduleId, runtimeDirectory)
        )
      });
      return;
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}
