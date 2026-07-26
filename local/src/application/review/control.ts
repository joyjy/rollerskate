import { realpathSync } from "node:fs";

import {
  readReviewArtifact,
  type ReviewArtifact
} from "../../capabilities/review/artifact-schema.js";
import { ReviewStore } from "../../capabilities/review/store.js";
import { workspaceRevision, type WorkspaceRevision } from "../../capabilities/review/workspace-revision.js";
import { RuntimeStore, type RuntimeAudit } from "../../core/runtime/store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

export interface ReviewInspection {
  readonly projection: import("../../capabilities/review/model.js").ReviewChainProjection;
  readonly subject: {
    readonly kind: "acceptance";
    readonly ref: string;
    readonly revision: string;
  };
  readonly reviewer: LocalAgent;
  readonly implementer: LocalAgent;
  readonly workspaceRevision?: WorkspaceRevision;
  readonly workspaceRevisionError?: string;
  readonly artifactRef: string;
  readonly artifact?: ReviewArtifact;
  readonly artifactError?: string;
  readonly audit: readonly RuntimeAudit[];
}

export function listReviews(
  repoRoot: string,
  runtimeDirectory?: string,
  limit = 100
): ReviewInspection[] {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.reviews.list(limit).map((projection) =>
      inspection(projection.rootEventId, stores))
  );
}

export function inspectReview(
  repoRoot: string,
  rootEventId: string,
  runtimeDirectory?: string
): ReviewInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    inspection(rootEventId, stores)
  );
}

interface Stores {
  readonly reviews: ReviewStore;
  readonly runtime: RuntimeStore;
  readonly foundation: LocalFoundationStore;
  readonly workspace: string;
}

function withStores<T>(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  callback: (stores: Stores) => T
): T {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const runtime = new RuntimeStore(paths.database);
  const reviews = new ReviewStore(paths.database);
  const foundation = new LocalFoundationStore(paths.database);
  try {
    const local = foundation.foundation();
    if (local === undefined) throw new Error("Local foundation is not initialized");
    return callback({
      reviews,
      runtime,
      foundation,
      workspace: realpathSync(local.workspacePath)
    });
  } finally {
    foundation.close();
    reviews.close();
    runtime.close();
  }
}

function inspection(rootEventId: string, stores: Stores): ReviewInspection {
  const projection = stores.reviews.requireProjection(rootEventId);
  const root = stores.runtime.event(rootEventId);
  if (root?.type !== "review.requested") {
    throw new Error(`Review root Event not found: ${rootEventId}`);
  }
  const reviewer = stores.foundation.agent(root.reviewerAgentId);
  const implementer = stores.foundation.agent(root.implementerAgentId);
  if (reviewer === undefined || implementer === undefined) {
    throw new Error(`Review Agent identity is missing: ${rootEventId}`);
  }
  const artifact = attempt(() => readReviewArtifact(root.artifactRef));
  const currentWorkspace = attempt(() => workspaceRevision(stores.workspace));
  return {
    projection,
    subject: root.subject,
    reviewer,
    implementer,
    ...(currentWorkspace.value === undefined
      ? { workspaceRevisionError: currentWorkspace.error! }
      : { workspaceRevision: currentWorkspace.value }),
    artifactRef: root.artifactRef,
    ...(artifact.error === undefined ? {} : { artifactError: artifact.error }),
    ...(artifact.value === undefined ? {} : { artifact: artifact.value }),
    audit: stores.reviews.eventIds(rootEventId)
      .map((eventId) => stores.runtime.audit(eventId))
      .filter((entry): entry is RuntimeAudit => entry !== undefined)
  };
}

function attempt<T>(callback: () => T): {
  readonly value?: T;
  readonly error?: string;
} {
  try {
    return { value: callback() };
  } catch (error) {
    return {
      error: (error instanceof Error ? error.message : String(error)).slice(0, 4_096)
    };
  }
}
