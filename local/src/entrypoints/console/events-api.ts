import type { ServerResponse } from "node:http";

import { eventTrace, listEventTraces } from "../../application/event/query.js";
import { json } from "./http.js";

export function serveEventsApi(
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
      json(response, 200, listEventTraces(repoRoot, runtimeDirectory));
      return;
    }
    if (parts.length === 3) {
      json(response, 200, eventTrace(
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
