import type { IncomingMessage, ServerResponse } from "node:http";

import {
  cancelStewardRun,
  closeStewardRunSeries,
  startStewardRun,
  submitCallerRunDecision,
  type StartStewardRunInput
} from "../../application/steward/control.js";
import {
  inspectStewardRunView,
  latestStewardRunView,
  listStewardRunViews
} from "../../application/steward/query.js";
import type { ConsoleRequestMarker } from "./http.js";
import {
  json,
  parseBoundedQueryInteger,
  readJsonBody,
  requireString
} from "./http.js";

type WorkspaceEffect = Extract<
  NonNullable<StartStewardRunInput["workspace"]>,
  { readonly access: "write" }
>["effect"];

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
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? 100
        : parseBoundedQueryInteger(limitValue, "run limit", 1, 200);
      json(response, 200, listStewardRunViews(repoRoot, runtimeDirectory, limit));
      return;
    }
    if (parts.length === 2 && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const body = await readJsonBody(request);
      json(response, 200, startStewardRun(
        repoRoot,
        stewardRunInput(body),
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
      json(response, 200, inspectStewardRunView(repoRoot, runId, runtimeDirectory));
      return;
    }
    if (parts.length === 4 && parts[3] === "cancel" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      json(response, 200, cancelStewardRun(repoRoot, runId, runtimeDirectory));
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

function stewardRunInput(
  body: Readonly<Record<string, unknown>>
): StartStewardRunInput {
  const workspaceValue = body.workspace;
  const seriesValue = body.series;
  let series: StartStewardRunInput["series"];
  if (seriesValue !== undefined) {
    if (typeof seriesValue !== "object" || seriesValue === null ||
      Array.isArray(seriesValue)) {
      throw new Error("series must be an object");
    }
    const record = seriesValue as Readonly<Record<string, unknown>>;
    if (Object.keys(record).length !== 2) {
      throw new Error("series must contain only key and sourceRevision");
    }
    series = {
      key: requireString(record, "key"),
      sourceRevision: requireString(record, "sourceRevision")
    };
  }
  let workspace: StartStewardRunInput["workspace"];
  if (workspaceValue !== undefined) {
    if (typeof workspaceValue !== "object" ||
      workspaceValue === null ||
      Array.isArray(workspaceValue)) {
      throw new Error("workspace must be an object");
    }
    const record = workspaceValue as Readonly<Record<string, unknown>>;
    const access = record.access;
    if (access !== "read" && access !== "write") {
      throw new Error("workspace.access must be read or write");
    }
    const effect = record.effect;
    if (access === "write" && effect !== "must_change" &&
      effect !== "may_remain_unchanged") {
      throw new Error("workspace.effect is required for write access");
    }
    if (access === "read" && effect !== undefined) {
      throw new Error("workspace.effect is valid only with write access");
    }
    if (access === "read") {
      workspace = { root: requireString(record, "root"), access };
    } else {
      workspace = {
        root: requireString(record, "root"),
        access,
        effect: effect as WorkspaceEffect
      };
    }
  }
  return {
    requestId: requireString(body, "requestId"),
    ...(series === undefined ? {} : { series }),
    ...(body.steward === undefined ? {} : { steward: requireString(body, "steward") }),
    ...(typeof body.objective === "string"
      ? { objective: body.objective }
      : {}),
    ...(typeof body.workflowRef === "string"
      ? { workflowRef: body.workflowRef }
      : {}),
    ...(body.inputs !== undefined
      ? { inputs: body.inputs as Readonly<Record<string, unknown>> }
      : {}),
    ...(workspace === undefined ? {} : { workspace }),
    ...(typeof body.maxSteps === "number" ? { maxSteps: body.maxSteps } : {}),
    ...(typeof body.maxDepth === "number" ? { maxDepth: body.maxDepth } : {}),
    ...(typeof body.deadlineAt === "string"
      ? { deadlineAt: body.deadlineAt }
      : {}),
    ...(typeof body.taskUrl === "string" ? { taskUrl: body.taskUrl } : {}),
    ...(body.participantAgentIds === undefined
      ? {}
      : { participantAgentIds: stringList(body.participantAgentIds) }),
    ...(body.orchestration === undefined
      ? {}
      : { orchestration: orchestrationInput(body.orchestration) })
  };
}

function orchestrationInput(
  value: unknown
): { readonly mode: "autonomous" | "caller" | "steward" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("orchestration.mode is invalid");
  }
  const orchestration = value as Readonly<Record<string, unknown>>;
  if (Object.keys(orchestration).length !== 1 ||
    (orchestration.mode !== "autonomous" && orchestration.mode !== "caller" &&
      orchestration.mode !== "steward")) {
    throw new Error("orchestration must contain only a supported mode");
  }
  return { mode: orchestration.mode };
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error("participantAgentIds must contain 1-64 strings");
  }
  return value as string[];
}
