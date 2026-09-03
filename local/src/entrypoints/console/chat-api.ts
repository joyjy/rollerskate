import type { IncomingMessage, ServerResponse } from "node:http";

import {
  dispatchLocalChatMessage,
  handoffLocalChatMessageToRun,
  localChatPresenceView,
  localChatView,
  postLocalChatMessage,
  rotateLocalAgentSession,
  setLocalChatPresence
} from "../../application/chat/control.js";
import {
  confirmLocalChatRunProposal,
  declineLocalChatRunProposal,
  preflightLocalChatRunProposal
} from
  "../../application/chat/run-proposal-control.js";
import type { ChatRunWorkspaceSelection } from
  "../../application/chat/run-proposal.js";
import {
  addLocalTopicParticipant,
  pauseLocalTopic,
  removeLocalTopicParticipant,
  resumeLocalTopic,
  type TopicGovernanceControlResult
} from "../../application/topic/governance-control.js";
import { inspectLocalTopicGovernance } from
  "../../application/topic/governance-query.js";
import {
  cancelLocalTopicActivationSchedule,
  createLocalTopicActivationSchedule,
  pauseLocalTopicActivationSchedule,
  resumeLocalTopicActivationSchedule
} from "../../application/topic/schedule-control.js";
import { localTopicActivationSchedules } from
  "../../application/topic/schedule-query.js";
import type { ConsoleRequestMarker } from "./http.js";
import {
  grantClientHistoryAccess,
  revokeClientHistoryAccess
} from "../../application/activity/client-history.js";
import {
  json,
  parseBoundedQueryInteger,
  readJsonBody,
  requireString
} from "./http.js";

export async function serveChatApi(
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
    if (url.pathname === "/api/chat" && method === "GET") {
      const beforeEventId = url.searchParams.get("before") ?? undefined;
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? undefined
        : parseBoundedQueryInteger(limitValue, "chat history limit", 1, 200);
      json(response, 200, localChatView(repoRoot, options, {
        ...(beforeEventId === undefined ? {} : { beforeEventId }),
        ...(limit === undefined ? {} : { limit })
      }));
      return;
    }
    if (url.pathname === "/api/chat/presence" && method === "GET") {
      json(response, 200, localChatPresenceView(repoRoot, options));
      return;
    }
    if (url.pathname === "/api/chat/governance" && method === "GET") {
      json(response, 200, inspectLocalTopicGovernance(repoRoot, runtimeDirectory));
      return;
    }
    if (url.pathname === "/api/chat/schedules" && method === "GET") {
      json(response, 200, localTopicActivationSchedules(repoRoot, runtimeDirectory));
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    if (url.pathname === "/api/chat/messages" && method === "POST") {
      const body = await readJsonBody(request);
      const replyToEventId = body.replyToEventId === undefined
        ? undefined
        : requireString(body, "replyToEventId");
      json(response, 201, postLocalChatMessage(
        repoRoot,
        requireString(body, "body"),
        options,
        replyToEventId === undefined ? {} : { replyToEventId }
      ));
      return;
    }
    const workHandoff = url.pathname.match(/^\/api\/chat\/messages\/([^/]+)\/run$/);
    if (workHandoff !== null && method === "POST") {
      json(response, 201, handoffLocalChatMessageToRun(
        repoRoot,
        decodeURIComponent(workHandoff[1]!),
        options
      ));
      return;
    }
    const proposalConfirmation = url.pathname.match(
      /^\/api\/chat\/proposals\/([^/]+)\/([^/]+)\/confirm$/
    );
    if (proposalConfirmation !== null && method === "POST") {
      const body = await readJsonBody(request);
      const result = confirmLocalChatRunProposal(
        repoRoot,
        decodeURIComponent(proposalConfirmation[1]!),
        decodeURIComponent(proposalConfirmation[2]!),
        requireString(body, "revision"),
        options,
        parseWorkspaceSelection(body, false)
      );
      json(response, result.status === "duplicate" ? 200 : 201, result);
      return;
    }
    const proposalDecline = url.pathname.match(
      /^\/api\/chat\/proposals\/([^/]+)\/([^/]+)\/decline$/
    );
    if (proposalDecline !== null && method === "POST") {
      const body = await readJsonBody(request);
      const result = declineLocalChatRunProposal(
        repoRoot,
        decodeURIComponent(proposalDecline[1]!),
        decodeURIComponent(proposalDecline[2]!),
        requireString(body, "revision"),
        options
      );
      json(response, result.status === "duplicate" ? 200 : 201, result);
      return;
    }
    const proposalPreflight = url.pathname.match(
      /^\/api\/chat\/proposals\/([^/]+)\/([^/]+)\/preflight$/
    );
    if (proposalPreflight !== null && method === "POST") {
      const body = await readJsonBody(request);
      json(response, 200, preflightLocalChatRunProposal(
        repoRoot,
        decodeURIComponent(proposalPreflight[1]!),
        decodeURIComponent(proposalPreflight[2]!),
        requireString(body, "revision"),
        parseWorkspaceSelection(body, true)!,
        options
      ));
      return;
    }
    if (url.pathname === "/api/chat/governance/pause" && method === "POST") {
      respondGovernanceControl(response, pauseLocalTopic(
        repoRoot, expectedRevision(await readJsonBody(request)), options
      ));
      return;
    }
    if (url.pathname === "/api/chat/governance/resume" && method === "POST") {
      respondGovernanceControl(response, resumeLocalTopic(
        repoRoot, expectedRevision(await readJsonBody(request)), options
      ));
      return;
    }
    if (url.pathname === "/api/chat/schedules" && method === "POST") {
      const body = await readJsonBody(request);
      const kind = requireString(body, "kind");
      if (kind !== "once" && kind !== "cron") throw new Error("kind must be once or cron");
      const misfirePolicy = body.misfirePolicy;
      if (misfirePolicy !== undefined && misfirePolicy !== "skip" &&
        misfirePolicy !== "run_once") throw new Error("misfirePolicy is unsupported");
      const candidatePolicy = body.candidatePolicy;
      if (candidatePolicy !== undefined && candidatePolicy !== "deterministic_one" &&
        candidatePolicy !== "sampled_sequential" && candidatePolicy !== "all_available") {
        throw new Error("candidatePolicy is unsupported");
      }
      const intent = body.intent;
      if (intent !== undefined && intent !== "continue_recent" &&
        intent !== "choose_from_themes" && intent !== "directed") {
        throw new Error("intent is unsupported");
      }
      const brief = body.brief;
      if (intent === "directed" && (typeof brief !== "string" || brief.trim() === "")) {
        throw new Error("directed intent requires brief");
      }
      if (intent !== "directed" && brief !== undefined) {
        throw new Error("brief requires directed intent");
      }
      json(response, 201, createLocalTopicActivationSchedule(repoRoot, {
        kind,
        expression: requireString(body, "expression"),
        ...(body.timezone === undefined ? {} : { timezone: requireString(body, "timezone") }),
        ...(misfirePolicy === undefined ? {} : { misfirePolicy }),
        ...(body.misfireGraceMilliseconds === undefined ? {} : {
          misfireGraceMilliseconds: boundedInteger(
            body.misfireGraceMilliseconds, "misfireGraceMilliseconds", 0, 604_800_000
          )
        }),
        ...(candidatePolicy === undefined ? {} : { candidatePolicy }),
        ...(intent === undefined ? {} : {
          intentPolicy: intent === "directed"
            ? { kind: "fixed_directed", brief: brief as string }
            : { kind: intent }
        }),
        ...(body.turnBudget === undefined ? {} : {
          turnBudget: boundedInteger(body.turnBudget, "turnBudget", 1, 64)
        })
      }, options));
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (method === "POST" && parts.length === 5 && parts[1] === "chat" &&
      parts[2] === "schedules" &&
      (parts[4] === "pause" || parts[4] === "resume" || parts[4] === "cancel")) {
      const revision = expectedRevision(await readJsonBody(request));
      const result = parts[4] === "pause"
        ? pauseLocalTopicActivationSchedule(repoRoot, parts[3]!, revision, options)
        : parts[4] === "resume"
          ? resumeLocalTopicActivationSchedule(repoRoot, parts[3]!, revision, options)
          : cancelLocalTopicActivationSchedule(repoRoot, parts[3]!, revision, options);
      json(response, result.outcome === "conflict" ? 409 : 200, result);
      return;
    }
    if (method === "POST" && parts.length === 6 && parts[1] === "chat" &&
      parts[2] === "governance" && parts[3] === "participants" &&
      (parts[5] === "add" || parts[5] === "remove")) {
      const revision = expectedRevision(await readJsonBody(request));
      const result = parts[5] === "add"
        ? addLocalTopicParticipant(repoRoot, parts[4]!, revision, options)
        : removeLocalTopicParticipant(repoRoot, parts[4]!, revision, options);
      respondGovernanceControl(response, result);
      return;
    }
    if (method === "POST" && parts.length === 5 &&
      parts[1] === "chat" && parts[2] === "agents" && parts[4] === "presence") {
      const body = await readJsonBody(request);
      const mode = requireString(body, "mode");
      json(response, 200, setLocalChatPresence(
        repoRoot,
        parts[3]!,
        {
          scope: "topic",
          mode,
          ...(mode === "snoozed" ? { until: requireString(body, "until") } : {}),
          wakeKeywords: []
        },
        options
      ));
      return;
    }
    if (method === "POST" && parts.length === 5 &&
      parts[1] === "chat" && parts[2] === "messages" && parts[4] === "dispatch") {
      const body = await readJsonBody(request);
      json(response, 200, dispatchLocalChatMessage(
        repoRoot,
        parts[3]!,
        requireString(body, "principalId"),
        options
      ));
      return;
    }
    if (method === "POST" && parts.length === 5 &&
      parts[1] === "chat" && parts[2] === "agents" && parts[4] === "new-session") {
      json(response, 200, {
        generation: rotateLocalAgentSession(repoRoot, parts[3]!, options)
      });
      return;
    }
    if (method === "POST" && parts.length === 5 &&
      parts[1] === "chat" && parts[2] === "agents" && parts[4] === "history-access") {
      const body = await readJsonBody(request);
      const action = requireString(body, "action");
      if (action !== "grant" && action !== "revoke") {
        throw new Error("action must be grant or revoke");
      }
      json(response, 200, action === "grant"
        ? grantClientHistoryAccess(repoRoot, parts[3]!, options)
        : revokeClientHistoryAccess(repoRoot, parts[3]!, options));
      return;
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function parseWorkspaceSelection(
  body: Readonly<Record<string, unknown>>,
  required: boolean
): ChatRunWorkspaceSelection | undefined {
  const kind = body.workspaceKind;
  if (kind === undefined && !required) {
    if (body.workspacePath !== undefined) {
      throw new Error("workspacePath requires workspaceKind=path");
    }
    return undefined;
  }
  if (kind !== "project" && kind !== "local" && kind !== "path") {
    throw new Error("workspaceKind must be project, local, or path");
  }
  if (kind !== "path") {
    if (body.workspacePath !== undefined) {
      throw new Error("workspacePath requires workspaceKind=path");
    }
    return { kind };
  }
  return { kind, path: requireString(body, "workspacePath") };
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function expectedRevision(body: Readonly<Record<string, unknown>>): number {
  const value = body.expectedRevision;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    throw new Error("expectedRevision must be an integer between 1 and 1000000");
  }
  return value as number;
}

function respondGovernanceControl(
  response: ServerResponse,
  result: TopicGovernanceControlResult
): void {
  json(response, result.outcome === "conflict" ? 409 : 200, result);
}
