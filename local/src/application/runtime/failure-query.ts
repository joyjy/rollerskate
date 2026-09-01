import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import {
  readRuntimeFailureFacts,
  type RuntimeFailureFact
} from "../../infrastructure/sqlite/runtime-operations-query.js";
import {
  noticeConsoleRoute,
  noticeIdForDelivery
} from "../notice/reference.js";

export type RuntimeFailureOwner =
  | "runtime"
  | "agent"
  | "event"
  | "chat"
  | "subscription"
  | "schedule"
  | "notice";

export interface RuntimeFailureSummary {
  readonly failureRef: string;
  readonly owner: RuntimeFailureOwner;
  readonly severity: "warning" | "error";
  readonly reason: string;
  readonly objectRef: string;
  readonly eventId?: string;
  readonly relatedRef?: string;
  readonly occurredAt: string;
  readonly action: {
    readonly kind: "inspect" | "recover" | "reconcile" | "configure";
    readonly available: boolean;
    readonly consoleRoute?: string;
    readonly cliHint: string;
  };
}

export interface RuntimeFailureDetail extends RuntimeFailureSummary {
  readonly evidence: readonly {
    readonly kind: "event" | "object" | "related";
    readonly ref: string;
  }[];
}

export function listRuntimeFailures(
  repoRoot: string,
  runtimeDirectory?: string,
  limit = 100
): readonly RuntimeFailureSummary[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("failure limit must be an integer between 1 and 200");
  }
  const database = runtimePaths(repoRoot, runtimeDirectory).database;
  const failures = readRuntimeFailureFacts(database, limit).map(failureSummary);
  const readiness = agentReadinessFailure(database);
  return [...(readiness === undefined ? [] : [readiness]), ...failures]
    .sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) ||
      right.failureRef.localeCompare(left.failureRef))
    .slice(0, limit);
}

export function inspectRuntimeFailure(
  repoRoot: string,
  failureRef: string,
  runtimeDirectory?: string
): RuntimeFailureDetail {
  const failure = listRuntimeFailures(repoRoot, runtimeDirectory, 200)
    .find((candidate) => candidate.failureRef === failureRef);
  if (failure === undefined) throw new Error(`Runtime failure not found: ${failureRef}`);
  return {
    ...failure,
    evidence: [
      { kind: "object", ref: failure.objectRef },
      ...(failure.eventId === undefined
        ? []
        : [{ kind: "event" as const, ref: failure.eventId }]),
      ...(failure.relatedRef === undefined
        ? []
        : [{ kind: "related" as const, ref: failure.relatedRef }])
    ]
  };
}

function failureSummary(fact: RuntimeFailureFact): RuntimeFailureSummary {
  const owner = ownerFor(fact.kind);
  const failureRef = runtimeFailureRef(fact.kind, fact.objectRef);
  return {
    failureRef,
    owner,
    severity: fact.kind === "schedule" ? "warning" : "error",
    reason: bounded(fact.reason, 512),
    objectRef: fact.objectRef,
    ...(fact.eventId === undefined ? {} : { eventId: fact.eventId }),
    ...(fact.relatedRef === undefined ? {} : { relatedRef: fact.relatedRef }),
    occurredAt: fact.occurredAt,
    action: actionFor(fact, owner)
  };
}

function ownerFor(kind: RuntimeFailureFact["kind"]): RuntimeFailureOwner {
  if (kind === "delivery") return "notice";
  if (kind === "execution") return "event";
  return kind;
}

function actionFor(
  fact: RuntimeFailureFact,
  owner: RuntimeFailureOwner
): RuntimeFailureSummary["action"] {
  if (owner === "schedule" && fact.relatedRef !== undefined) {
    return {
      kind: "reconcile",
      available: true,
      consoleRoute:
        `/console/schedules?scheduleId=${encodeURIComponent(fact.relatedRef)}`,
      cliHint: `scripts/rs schedule trace ${fact.objectRef}`
    };
  }
  if (owner === "notice") {
    const noticeId = noticeIdForDelivery(fact.objectRef);
    return {
      kind: "recover",
      available: true,
      consoleRoute: noticeConsoleRoute(noticeId),
      cliHint: `scripts/rs failure retry failure:delivery:${fact.objectRef}`
    };
  }
  if (fact.eventId !== undefined) {
    return {
      kind: "inspect",
      available: true,
      consoleRoute: `/console/events?eventId=${encodeURIComponent(fact.eventId)}`,
      cliHint: `scripts/rs event trace ${fact.eventId}`
    };
  }
  if (owner === "subscription") {
    return {
      kind: "inspect",
      available: true,
      consoleRoute:
        `/console/subscriptions?subscriptionId=${encodeURIComponent(fact.objectRef)}`,
      cliHint: `scripts/rs subscription inspect ${fact.objectRef}`
    };
  }
  return {
    kind: "inspect",
    available: true,
    cliHint: `scripts/rs failure inspect failure:${fact.kind}:${fact.objectRef}`
  };
}

export function runtimeFailureRef(
  kind: RuntimeFailureFact["kind"],
  objectRef: string
): string {
  return `failure:${kind}:${objectRef}`;
}

export function runtimeFailureConsoleRoute(
  failureRef: string
): string {
  return `/console/runtime?failureRef=${encodeURIComponent(failureRef)}`;
}

function agentReadinessFailure(database: string): RuntimeFailureSummary | undefined {
  if (!existsSync(database)) return undefined;
  const connection = new DatabaseSync(database, { readOnly: true });
  const store = new LocalFoundationStore(connection, { migrate: false });
  try {
    const foundation = store.foundation();
    if (foundation === undefined) return undefined;
    const agents = store.listAgents();
    if (agents.some((agent) => agent.status === "active")) return undefined;
    return {
      failureRef: "failure:agent:no-callable-agent",
      owner: "agent",
      severity: "error",
      reason: "No active local Agent is available to process Agent workload.",
      objectRef: "local-agent-roster",
      occurredAt: foundation.createdAt,
      action: {
        kind: "configure",
        available: true,
        consoleRoute: "/console/agents",
        cliHint: "scripts/rs agent list"
      }
    };
  } finally {
    store.close();
    connection.close();
  }
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
