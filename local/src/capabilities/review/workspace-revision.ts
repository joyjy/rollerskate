export {
  fileRevision,
  type WorkspaceRevision
} from "../../infrastructure/workspace/revision.js";
import {
  workspaceRevision as gitWorkspaceRevision,
  type WorkspaceRevision
} from "../../infrastructure/workspace/revision.js";

const REVIEW_TRACKED_EXCLUDES = [
  "**/*.review.yaml",
  "*.review.yaml",
  "**/*.review.yaml.tmp-*",
  "*.review.yaml.tmp-*"
] as const;

export function workspaceRevision(workspace: string): WorkspaceRevision {
  return gitWorkspaceRevision(workspace, {
    trackedExcludes: REVIEW_TRACKED_EXCLUDES,
    ignoreUntracked: (path) =>
      path.endsWith(".review.yaml") ||
      /\.review\.yaml\.tmp-[^/]+$/.test(path)
  });
}
