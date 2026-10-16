import { resolveRegisteredSubscriptionPlugin, type RegisteredSubscriptionPlugin } from "../subscription/plugin-registry.js";
import type { DeterministicRunIntent } from "../../modules/run/intent.js";

const INPUT_SCHEMA = "GitLabPipelineInput@1";
const BUILD_PIPELINE_REF = "plugin:build-pipeline@1";

export interface GitLabPipelineSubmission {
  readonly requestId: string;
  readonly project: string;
  readonly pipelineId: number;
  readonly expectedSha: string;
  readonly resultDestinationRef: string;
  readonly timeoutSeconds: number;
  readonly checkpointSeconds?: number;
}

/**
 * Converts a narrow GitLab observation request into the ordinary deterministic
 * Run contract. GitLab transport and result semantics remain owned by the
 * registered Plugin; this only accepts its Owner-declared typed interface.
 */
export function compileGitLabPipelineRunIntent(
  repoRoot: string,
  submission: GitLabPipelineSubmission,
  runtimeDirectory?: string
): DeterministicRunIntent {
  const source = resolveGitLabPipelineSource(repoRoot, runtimeDirectory);
  validateSubmission(submission);
  return {
    schemaVersion: "RunIntent@2",
    requestId: submission.requestId,
    title: `Observe GitLab pipeline ${submission.project}#${submission.pipelineId}`,
    resultDestinationRef: submission.resultDestinationRef,
    maxWaitMilliseconds: submission.timeoutSeconds * 1_000,
    ...(submission.checkpointSeconds === undefined ? {} : {checkpointMilliseconds: submission.checkpointSeconds * 1_000}),
    work: {
      kind: "observe",
      mode: "until",
      sourceRef: BUILD_PIPELINE_REF,
      input: {
        schemaVersion: INPUT_SCHEMA,
        transport: {
          kind: "command",
          executable: source.transport.executable,
          project: submission.project,
          pipelineId: submission.pipelineId,
          ...(source.transport.cwd === undefined ? {} : { cwd: source.transport.cwd })
        },
        expectedSha: submission.expectedSha
      }
    }
  };
}

function resolveGitLabPipelineSource(
  repoRoot: string,
  runtimeDirectory?: string
): NonNullable<RegisteredSubscriptionPlugin["gitlabPipeline"]> {
  const plugin = resolveRegisteredSubscriptionPlugin(repoRoot, BUILD_PIPELINE_REF, runtimeDirectory);
  if (plugin === undefined) {
    throw new Error("GitLab pipeline source plugin:build-pipeline@1 is not registered; no command fallback is available.");
  }
  if (plugin.id !== "build-pipeline" || !plugin.triggerKinds.includes("until") || plugin.gitlabPipeline === undefined) {
    throw new Error("Registered build-pipeline source does not declare GitLabPipelineInput@1 compatibility; update its Owner registry entry before submitting.");
  }
  return plugin.gitlabPipeline;
}

function validateSubmission(value: GitLabPipelineSubmission): void {
  text(value.requestId, "requestId", 256);
  text(value.resultDestinationRef, "resultDestinationRef", 256);
  if (!/^(?:[1-9][0-9]*|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/u.test(value.project) || value.project.length > 512) {
    throw new Error("project must be a GitLab numeric project ID or slash-delimited project path");
  }
  if (!Number.isSafeInteger(value.pipelineId) || value.pipelineId < 1) {
    throw new Error("pipelineId must be a positive safe integer");
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value.expectedSha)) {
    throw new Error("expectedSha must be an exact lowercase 40- or 64-character commit SHA");
  }
  if (!Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 31 * 86_400) {
    throw new Error("timeoutSeconds must be 1-2678400");
  }
  if (value.checkpointSeconds !== undefined && (!Number.isInteger(value.checkpointSeconds) || value.checkpointSeconds < 1 || value.checkpointSeconds > value.timeoutSeconds)) {
    throw new Error("checkpointSeconds must be an integer between 1 and timeoutSeconds");
  }
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value;
}
