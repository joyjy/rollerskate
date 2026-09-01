import type { ServerResponse } from "node:http";

import {
  controlSubscriptionView,
  inspectSubscriptionView,
  pageSubscriptionViews,
  setSubscriptionArchivedView
} from "../../application/subscription/control.js";
import type { ConsoleRequestMarker } from "./http.js";
import { json, parseListPageQuery } from "./http.js";

export function serveSubscriptionApi(
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
      json(response, 200, pageSubscriptionViews(
        repoRoot,
        parseListPageQuery(url),
        runtimeDirectory
      ));
      return;
    }
    const subscriptionId = parts[2];
    if (subscriptionId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, inspectSubscriptionView(
        repoRoot, subscriptionId, runtimeDirectory
      ));
      return;
    }
    const action = parts[3];
    if (parts.length === 4 && method === "POST" &&
      (action === "pause" || action === "resume" || action === "cancel")) {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const subscription = controlSubscriptionView(
        repoRoot,
        subscriptionId,
        action,
        runtimeDirectory
      );
      json(response, 200, subscription);
      return;
    }
    if (parts.length === 4 && method === "POST" &&
      (action === "archive" || action === "unarchive")) {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const subscription = setSubscriptionArchivedView(
        repoRoot,
        subscriptionId,
        action === "archive",
        runtimeDirectory
      );
      json(response, 200, { subscription, status: action });
      return;
    }
    json(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}
