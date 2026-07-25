import { basename } from "node:path";

import type { ReviewArtifact } from "../../capabilities/review/artifact-schema.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import {
  eventTraceViews,
  type EventTraceView
} from "../event/query.js";
import {
  runtimeFailureConsoleRoute,
  runtimeFailureRef
} from "../runtime/failure-query.js";
import {
  inspectReview,
  listReviews,
  type ReviewInspection
} from "./control.js";

export interface ReviewSummaryView {
  readonly rootEventId: string;
  readonly subject: {
    readonly ref: string;
    readonly name: string;
    readonly revision: string;
  };
  readonly reviewer: AgentReferenceView;
  readonly implementer: AgentReferenceView;
  readonly phase: "reviewing" | "implementing" | "terminal";
  readonly statusReason: string;
  readonly cycleIndex: number;
  readonly revisions: {
    readonly artifact: string | null;
    readonly implementation: string;
  };
  readonly rework: {
    readonly count: number;
    readonly limit: number;
  };
  readonly findings: {
    readonly open: number;
    readonly resolved: number;
    readonly total: number;
  };
  readonly terminalDecision: "passed" | "blocked" | null;
  readonly terminalReason: string | null;
  readonly availableActions: {
    readonly recover: boolean;
  };
  readonly failure: {
    readonly failureRef: string;
    readonly consoleRoute: string;
  } | null;
  readonly updatedAt: string;
}

export interface ReviewDetailView {
  readonly summary: ReviewSummaryView;
  readonly artifactRef: string;
  readonly artifact: ReviewArtifact | null;
  readonly artifactError: string | null;
  readonly workspaceRevision: ReviewInspection["workspaceRevision"] | null;
  readonly workspaceRevisionError: string | null;
  readonly audit: readonly EventTraceView[];
}

interface AgentReferenceView {
  readonly principalId: string;
  readonly handle: string;
  readonly client: LocalAgent["client"];
  readonly status: LocalAgent["status"];
}

export function listReviewViews(
  repoRoot: string,
  runtimeDirectory?: string,
  limit = 100
): readonly ReviewSummaryView[] {
  return listReviews(repoRoot, runtimeDirectory, limit).map(reviewSummaryView);
}

export function inspectReviewView(
  repoRoot: string,
  rootEventId: string,
  runtimeDirectory?: string
): ReviewDetailView {
  return reviewDetailView(inspectReview(repoRoot, rootEventId, runtimeDirectory));
}

export function reviewSummaryView(inspection: ReviewInspection): ReviewSummaryView {
  const artifact = inspection.artifact;
  const open = artifact?.findings.filter((finding) => finding.status === "open").length ?? 0;
  const resolved = artifact?.findings.filter((finding) =>
    finding.status === "resolved").length ?? 0;
  const failureRef = inspection.projection.terminalDecision === "blocked"
    ? runtimeFailureRef("review", inspection.projection.rootEventId)
    : null;
  return {
    rootEventId: inspection.projection.rootEventId,
    subject: {
      ref: inspection.subject.ref,
      name: basename(inspection.subject.ref),
      revision: inspection.subject.revision
    },
    reviewer: agentReference(inspection.reviewer),
    implementer: agentReference(inspection.implementer),
    phase: inspection.projection.phase,
    statusReason: reviewStatusReason(inspection),
    cycleIndex: inspection.projection.cycleIndex,
    revisions: {
      artifact: inspection.projection.artifactRevision ?? null,
      implementation: inspection.projection.implementationRevision
    },
    rework: {
      count: inspection.projection.reworkCount,
      limit: inspection.projection.reworkLimit
    },
    findings: {
      open,
      resolved,
      total: open + resolved
    },
    terminalDecision: inspection.projection.terminalDecision ?? null,
    terminalReason: inspection.projection.terminalReason ?? null,
    availableActions: {
      recover: recoverAvailable(inspection)
    },
    failure: failureRef === null
      ? null
      : {
          failureRef,
          consoleRoute: runtimeFailureConsoleRoute(failureRef)
        },
    updatedAt: inspection.projection.updatedAt
  };
}

export function reviewDetailView(inspection: ReviewInspection): ReviewDetailView {
  return {
    summary: reviewSummaryView(inspection),
    artifactRef: inspection.artifactRef,
    artifact: inspection.artifact ?? null,
    artifactError: inspection.artifactError ?? null,
    workspaceRevision: inspection.workspaceRevision ?? null,
    workspaceRevisionError: inspection.workspaceRevisionError ?? null,
    audit: eventTraceViews(inspection.audit)
  };
}

function recoverAvailable(inspection: ReviewInspection): boolean {
  if (inspection.projection.phase === "terminal") return false;
  const expected = inspection.audit.find(({ event }) =>
    event.eventId === inspection.projection.expectedEventId);
  return expected?.execution?.status === "failed" ||
    expected?.execution?.status === "succeeded";
}

function reviewStatusReason(inspection: ReviewInspection): string {
  const projection = inspection.projection;
  if (projection.phase === "terminal") {
    return projection.terminalReason ??
      `Review finished with ${projection.terminalDecision ?? "unknown"} decision.`;
  }
  if (projection.phase === "implementing") {
    return "Implementer is addressing the current open findings.";
  }
  return projection.cycleIndex === 0
    ? "Reviewer is evaluating the fixed subject and workspace evidence."
    : "Reviewer is re-evaluating the latest implementation revision.";
}

function agentReference(agent: LocalAgent): AgentReferenceView {
  return {
    principalId: agent.principalId,
    handle: agent.handle,
    client: agent.client,
    status: agent.status
  };
}
