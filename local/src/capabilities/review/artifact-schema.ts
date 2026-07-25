import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ImplementerResult, ReviewerResult } from "./result-contract.js";

export const REVIEW_ARTIFACT_SCHEMA_VERSION = "mrsf.review@1" as const;
const MAX_ARTIFACT_BYTES = 1_048_576;

export interface ReviewArtifact {
  readonly schemaVersion: typeof REVIEW_ARTIFACT_SCHEMA_VERSION;
  readonly subject: {
    readonly ref: string;
    readonly revision: string;
  };
  readonly rootReviewId: string;
  readonly artifactRevision: string;
  readonly findings: readonly ReviewFinding[];
}

export interface ReviewFinding {
  readonly findingId: string;
  readonly anchor: {
    readonly ref: string;
    readonly line?: number;
  };
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly summary: string;
  readonly status: "open" | "resolved";
  readonly reviewerAgentId: string;
  readonly implementerReplies: readonly {
    readonly implementerAgentId: string;
    readonly summary: string;
    readonly evidenceRefs: readonly string[];
    readonly at: string;
  }[];
  readonly resolutionEvidence: readonly {
    readonly reviewerAgentId: string;
    readonly summary: string;
    readonly revisionsRead: readonly string[];
    readonly at: string;
  }[];
}

export function reviewArtifactRef(subjectRef: string): string {
  if (!isAbsolute(subjectRef)) throw new Error("subject ref must be an absolute path");
  return `${resolve(subjectRef)}.review.yaml`;
}

export function readReviewArtifact(path: string): ReviewArtifact | undefined {
  if (!existsSync(path)) return undefined;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("review artifact must be a regular non-symlink file");
  }
  if (metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`review artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`review artifact must be JSON-compatible YAML: ${message(error)}`);
  }
  return validateArtifact(value);
}

export function createReviewArtifact(input: {
  readonly subjectRef: string;
  readonly subjectRevision: string;
  readonly rootReviewId: string;
}): ReviewArtifact {
  return withRevision({
    schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
    subject: {
      ref: input.subjectRef,
      revision: input.subjectRevision
    },
    rootReviewId: input.rootReviewId,
    artifactRevision: "",
    findings: []
  });
}

export function applyReviewerResult(
  artifact: ReviewArtifact,
  result: ReviewerResult,
  reviewerAgentId: string,
  cycleIndex: number,
  at = new Date().toISOString()
): ReviewArtifact {
  const findings = artifact.findings.map((finding) => {
    if (!result.artifactMutation.resolveFindingIds.includes(finding.findingId)) {
      return finding;
    }
    if (finding.status !== "open") {
      throw new Error(`finding is not open: ${finding.findingId}`);
    }
    return {
      ...finding,
      status: "resolved" as const,
      resolutionEvidence: [
        ...finding.resolutionEvidence,
        {
          reviewerAgentId,
          summary: result.boundedSummary,
          revisionsRead: [
            result.revisionsRead.subject,
            ...(result.revisionsRead.artifact === undefined
              ? []
              : [result.revisionsRead.artifact]),
            ...result.revisionsRead.evidence.map((evidence) => evidence.revision)
          ],
          at
        }
      ]
    };
  });
  for (const findingId of result.artifactMutation.resolveFindingIds) {
    if (!artifact.findings.some((finding) => finding.findingId === findingId)) {
      throw new Error(`finding not found: ${findingId}`);
    }
  }
  for (const [index, finding] of result.artifactMutation.addFindings.entries()) {
    const findingId = stableFindingId(
      artifact.rootReviewId,
      cycleIndex,
      index,
      finding.anchor.ref,
      finding.summary
    );
    if (findings.some((existing) => existing.findingId === findingId)) continue;
    findings.push({
      findingId,
      anchor: finding.anchor,
      severity: finding.severity,
      summary: finding.summary,
      status: "open",
      reviewerAgentId,
      implementerReplies: [],
      resolutionEvidence: []
    });
  }
  return withRevision({ ...artifact, artifactRevision: "", findings });
}

export function applyImplementerResult(
  artifact: ReviewArtifact,
  result: ImplementerResult,
  implementerAgentId: string,
  at = new Date().toISOString()
): ReviewArtifact {
  const replies = new Map(result.findingReplies.map((reply) => [reply.findingId, reply]));
  for (const findingId of replies.keys()) {
    const finding = artifact.findings.find((candidate) => candidate.findingId === findingId);
    if (finding === undefined) throw new Error(`finding not found: ${findingId}`);
    if (finding.status !== "open") throw new Error(`finding is not open: ${findingId}`);
  }
  const findings = artifact.findings.map((finding) => {
    const reply = replies.get(finding.findingId);
    return reply === undefined
      ? finding
      : {
          ...finding,
          implementerReplies: [
            ...finding.implementerReplies,
            {
              implementerAgentId,
              summary: reply.summary,
              evidenceRefs: reply.evidenceRefs,
              at
            }
          ]
        };
  });
  return withRevision({ ...artifact, artifactRevision: "", findings });
}

export function writeReviewArtifact(path: string, artifact: ReviewArtifact): ReviewArtifact {
  const validated = validateArtifact(artifact);
  if (resolve(dirname(path)) !== resolve(dirname(validated.subject.ref))) {
    throw new Error("review artifact must be beside its subject");
  }
  if (resolve(path) !== reviewArtifactRef(validated.subject.ref)) {
    throw new Error("review artifact path does not match subject");
  }
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("review artifact must be a regular non-symlink file");
    }
  }
  const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  renameSync(temporary, path);
  return validated;
}

export function validateArtifact(value: unknown): ReviewArtifact {
  if (!isRecord(value) || value.schemaVersion !== REVIEW_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`review artifact schemaVersion must be ${REVIEW_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (!isRecord(value.subject) || !Array.isArray(value.findings)) {
    throw new Error("review artifact subject or findings is malformed");
  }
  const artifact: ReviewArtifact = {
    schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
    subject: {
      ref: text(value.subject.ref, "subject.ref", 4_096),
      revision: text(value.subject.revision, "subject.revision", 256)
    },
    rootReviewId: text(value.rootReviewId, "rootReviewId", 128),
    artifactRevision: text(value.artifactRevision, "artifactRevision", 256),
    findings: value.findings.map((finding, index) => validateFinding(finding, index))
  };
  if (artifact.artifactRevision !== artifactRevision(artifact)) {
    throw new Error("review artifact revision does not match content");
  }
  return artifact;
}

export function artifactRevision(artifact: ReviewArtifact): string {
  return `mrsf1_${createHash("sha256")
    .update(JSON.stringify({ ...artifact, artifactRevision: "" }))
    .digest("hex")}`;
}

function withRevision(artifact: ReviewArtifact): ReviewArtifact {
  return { ...artifact, artifactRevision: artifactRevision(artifact) };
}

function validateFinding(value: unknown, index: number): ReviewFinding {
  if (!isRecord(value) || !isRecord(value.anchor) ||
    !Array.isArray(value.implementerReplies) || !Array.isArray(value.resolutionEvidence)) {
    throw new Error(`findings[${index}] is malformed`);
  }
  const line = value.anchor.line === undefined
    ? undefined
    : integer(value.anchor.line, `findings[${index}].anchor.line`, 1);
  return {
    findingId: text(value.findingId, `findings[${index}].findingId`, 128),
    anchor: {
      ref: text(value.anchor.ref, `findings[${index}].anchor.ref`, 4_096),
      ...(line === undefined ? {} : { line })
    },
    severity: oneOf(
      value.severity,
      ["low", "medium", "high", "critical"] as const,
      `findings[${index}].severity`
    ),
    summary: text(value.summary, `findings[${index}].summary`, 2_048),
    status: oneOf(value.status, ["open", "resolved"] as const, `findings[${index}].status`),
    reviewerAgentId: text(
      value.reviewerAgentId,
      `findings[${index}].reviewerAgentId`,
      128
    ),
    implementerReplies: value.implementerReplies.map((reply, replyIndex) => {
      if (!isRecord(reply) || !Array.isArray(reply.evidenceRefs)) {
        throw new Error(`findings[${index}].implementerReplies[${replyIndex}] is malformed`);
      }
      return {
        implementerAgentId: text(
          reply.implementerAgentId,
          `findings[${index}].implementerReplies[${replyIndex}].implementerAgentId`,
          128
        ),
        summary: text(
          reply.summary,
          `findings[${index}].implementerReplies[${replyIndex}].summary`,
          2_048
        ),
        evidenceRefs: reply.evidenceRefs.map((ref, evidenceIndex) =>
          text(
            ref,
            `findings[${index}].implementerReplies[${replyIndex}].evidenceRefs[${evidenceIndex}]`,
            4_096
          )),
        at: date(reply.at, `findings[${index}].implementerReplies[${replyIndex}].at`)
      };
    }),
    resolutionEvidence: value.resolutionEvidence.map((resolution, resolutionIndex) => {
      if (!isRecord(resolution) || !Array.isArray(resolution.revisionsRead)) {
        throw new Error(`findings[${index}].resolutionEvidence[${resolutionIndex}] is malformed`);
      }
      return {
        reviewerAgentId: text(
          resolution.reviewerAgentId,
          `findings[${index}].resolutionEvidence[${resolutionIndex}].reviewerAgentId`,
          128
        ),
        summary: text(
          resolution.summary,
          `findings[${index}].resolutionEvidence[${resolutionIndex}].summary`,
          2_048
        ),
        revisionsRead: resolution.revisionsRead.map((revision, revisionIndex) =>
          text(
            revision,
            `findings[${index}].resolutionEvidence[${resolutionIndex}].revisionsRead[${revisionIndex}]`,
            256
          )),
        at: date(resolution.at, `findings[${index}].resolutionEvidence[${resolutionIndex}].at`)
      };
    })
  };
}

function stableFindingId(...parts: readonly (string | number)[]): string {
  return `fnd_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return value;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${field} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function date(value: unknown, field: string): string {
  const normalized = text(value, field, 64);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${field} must be RFC3339`);
  return normalized;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
