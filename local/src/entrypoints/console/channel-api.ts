import type { IncomingMessage, ServerResponse } from "node:http";

import {
  bindInteractiveChannel,
  parseInteractiveChannelRef,
  revokeInteractiveChannel,
  sendInteractiveChannelMessage,
  stopInteractiveChannelFollow
} from "../../application/channel/control.js";
import {
  inspectInteractiveChannelBinding,
  inspectInteractiveChannelFollow,
  followInteractiveChannel
} from "../../application/channel/query.js";
import type { ConsoleRequestMarker } from "./http.js";
import { json, readJsonBody, requireString } from "./http.js";

export async function serveChannelApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  fetchImplementation: typeof fetch | undefined,
  request: IncomingMessage,
  requestMarker: ConsoleRequestMarker,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const options = {
    ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
    ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation })
  };
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (method === "GET" && parts.length === 3 && parts[0] === "api" &&
      parts[1] === "channels") {
      json(response, 200, inspectInteractiveChannelBinding(
        repoRoot, parts[2]!, runtimeDirectory
      ));
      return;
    }
    if (method === "GET" && parts.length === 4 && parts[0] === "api" &&
      parts[1] === "channels" && parts[2] === "follows") {
      const wait = url.searchParams.get("waitMilliseconds");
      json(response, 200, wait === null
        ? inspectInteractiveChannelFollow(repoRoot, parts[3]!, runtimeDirectory)
        : await followInteractiveChannel(repoRoot, parts[3]!, boundedInteger(
            Number(wait), "waitMilliseconds", 0, 30_000
          ), {
            ...options,
            ...(url.searchParams.get("afterCursor") === null
              ? {} : { afterCursor: url.searchParams.get("afterCursor")! })
          }));
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "api" &&
      parts[1] === "channels" && parts[2] === "bindings") {
      const body = await readJsonBody(request);
      if (!Array.isArray(body.allowedChannelRefs)) {
        throw new Error("allowedChannelRefs must be an array");
      }
      json(response, 201, bindInteractiveChannel(repoRoot, {
        agentId: requireString(body, "agentId"),
        allowedChannelRefs: body.allowedChannelRefs.map((ref, index) =>
          parseInteractiveChannelRef(ref, `allowedChannelRefs[${index}]`)),
        expiresAt: requireString(body, "expiresAt"),
        ...(body.callbackSessionId === undefined
          ? {} : { callbackSessionId: requireString(body, "callbackSessionId") })
      }, options));
      return;
    }
    if (method === "POST" && parts.length === 4 && parts[0] === "api" &&
      parts[1] === "channels" && parts[3] === "send") {
      const body = await readJsonBody(request);
      const condition = body.followCondition;
      if (condition !== undefined && condition !== "first_reply" && condition !== "quiet" &&
        condition !== "terminal" && condition !== "failed") {
        throw new Error("followCondition is unsupported");
      }
      json(response, 201, await sendInteractiveChannelMessage(repoRoot, {
        bindingId: parts[2]!,
        channelRef: parseInteractiveChannelRef(body.channelRef),
        idempotencyKey: requireString(body, "idempotencyKey"),
        body: requireString(body, "body"),
        ...(condition === undefined ? {} : { followCondition: condition }),
        ...(body.quietWindowMilliseconds === undefined ? {} : {
          quietWindowMilliseconds: boundedInteger(
            body.quietWindowMilliseconds, "quietWindowMilliseconds", 0, 86_400_000
          )
        }),
        ...(body.followDeadlineAt === undefined
          ? {} : { followDeadlineAt: requireString(body, "followDeadlineAt") })
      }, options));
      return;
    }
    if (method === "POST" && parts.length === 4 && parts[0] === "api" &&
      parts[1] === "channels" && parts[3] === "revoke") {
      json(response, 200, revokeInteractiveChannel(
        repoRoot, parts[2]!, expectedRevision(await readJsonBody(request)), options
      ));
      return;
    }
    if (method === "POST" && parts.length === 5 && parts[0] === "api" &&
      parts[1] === "channels" && parts[2] === "follows" && parts[4] === "stop") {
      json(response, 200, stopInteractiveChannelFollow(
        repoRoot, parts[3]!, expectedRevision(await readJsonBody(request)), options
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

function expectedRevision(body: Readonly<Record<string, unknown>>): number {
  if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 1 ||
    (body.expectedRevision as number) > 1_000_000) {
    throw new Error("expectedRevision must be an integer between 1 and 1000000");
  }
  return body.expectedRevision as number;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}
