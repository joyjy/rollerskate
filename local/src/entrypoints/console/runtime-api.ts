import type { ServerResponse } from "node:http";

import { acknowledgeNotice, markNoticeRead, rebuildNoticeIndex } from "../../application/notice/control.js";
import { inspectNoticeView, noticeCenterView } from "../../application/notice/query.js";
import { controlRuntime } from "../../application/runtime/control.js";
import { inspectRuntimeFailure, listRuntimeFailures } from "../../application/runtime/failure-query.js";
import {
  runtimeOperationsView,
  type RuntimeControlResultView
} from "../../application/runtime/query.js";
import type { ConsoleRequestMarker } from "./http.js";
import { json, parseBoundedQueryInteger } from "./http.js";

export function serveRuntimeApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  method: string,
  requestMarker: ConsoleRequestMarker,
  consoleAddress: string,
  url: URL,
  response: ServerResponse
): void {
  try {
    if (url.pathname === "/api/runtime" && method === "GET") {
      json(response, 200, runtimeOperationsView(
        repoRoot,
        runtimeDirectory,
        consoleAddress
      ));
      return;
    }
    const action = url.pathname.split("/").filter(Boolean)[2];
    if (method === "POST" &&
      (action === "pause" || action === "resume" || action === "recover")) {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const controlResult: RuntimeControlResultView = controlRuntime(
        repoRoot,
        action,
        runtimeDirectory
      );
      json(response, 200, runtimeOperationsView(
        repoRoot,
        runtimeDirectory,
        consoleAddress,
        controlResult
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

export function serveRuntimeFailureApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  method: string,
  url: URL,
  response: ServerResponse
): void {
  if (method !== "GET") {
    json(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 2) {
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? 100
        : parseBoundedQueryInteger(limitValue, "failure limit", 1, 200);
      json(response, 200, listRuntimeFailures(repoRoot, runtimeDirectory, limit));
      return;
    }
    if (parts.length === 3) {
      json(response, 200, inspectRuntimeFailure(
        repoRoot,
        parts[2]!,
        runtimeDirectory
      ));
      return;
    }
    json(response, 404, { error: "not_found" });
  } catch (error) {
    json(response, 404, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function serveNoticeApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  method: string,
  requestMarker: ConsoleRequestMarker,
  url: URL,
  response: ServerResponse
): void {
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 2 && method === "GET") {
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? 100
        : parseBoundedQueryInteger(limitValue, "notice limit", 1, 1_000);
      json(response, 200, noticeCenterView(repoRoot, runtimeDirectory, limit));
      return;
    }
    if (parts.length === 3 && parts[2] === "rebuild" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      json(response, 200, rebuildNoticeIndex(repoRoot, runtimeDirectory));
      return;
    }
    const noticeId = parts[2];
    if (noticeId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, inspectNoticeView(repoRoot, noticeId, runtimeDirectory));
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    const action = parts[3];
    if (parts.length === 4 && method === "POST" &&
      (action === "mark-read" || action === "ack")) {
      json(response, 200, action === "mark-read"
        ? markNoticeRead(repoRoot, noticeId, runtimeDirectory)
        : acknowledgeNotice(repoRoot, noticeId, runtimeDirectory));
      return;
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}
