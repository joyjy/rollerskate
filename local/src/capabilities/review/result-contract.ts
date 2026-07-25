import type { ReviewDecision, ReviewEvidence } from "./model.js";

export interface ReviewerFindingInput {
  readonly anchor: {
    readonly ref: string;
    readonly line?: number;
  };
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly summary: string;
}

export interface ReviewerResult {
  readonly schemaVersion: "ReviewerResult@1";
  readonly decision: ReviewDecision;
  readonly boundedSummary: string;
  readonly revisionsRead: {
    readonly subject: string;
    readonly artifact?: string;
    readonly evidence: readonly ReviewEvidence[];
  };
  readonly artifactMutation: {
    readonly addFindings: readonly ReviewerFindingInput[];
    readonly resolveFindingIds: readonly string[];
  };
}

export interface ImplementerResult {
  readonly schemaVersion: "ImplementerResult@1";
  readonly boundedSummary: string;
  readonly findingReplies: readonly {
    readonly findingId: string;
    readonly summary: string;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly implementationRevision: string;
}

export function parseReviewerResult(output: string): ReviewerResult {
  const root = record(parse(output, "ReviewerResult"), "ReviewerResult");
  exactKeys(root, [
    "schemaVersion", "decision", "boundedSummary", "revisionsRead", "artifactMutation"
  ], "ReviewerResult");
  if (root.schemaVersion !== "ReviewerResult@1") {
    throw new Error("ReviewerResult schemaVersion must be ReviewerResult@1");
  }
  const revisions = record(root.revisionsRead, "ReviewerResult.revisionsRead");
  exactKeys(revisions, ["subject", "artifact", "evidence"], "ReviewerResult.revisionsRead");
  const mutation = record(root.artifactMutation, "ReviewerResult.artifactMutation");
  exactKeys(
    mutation,
    ["addFindings", "resolveFindingIds"],
    "ReviewerResult.artifactMutation"
  );
  const addFindings = array(mutation.addFindings, "artifactMutation.addFindings")
    .map((value, index) => {
      const finding = record(value, `artifactMutation.addFindings[${index}]`);
      exactKeys(
        finding,
        ["anchor", "severity", "summary"],
        `artifactMutation.addFindings[${index}]`
      );
      const anchor = record(finding.anchor, `artifactMutation.addFindings[${index}].anchor`);
      exactKeys(anchor, ["ref", "line"], `artifactMutation.addFindings[${index}].anchor`);
      const line = anchor.line === undefined
        ? undefined
        : integer(anchor.line, `artifactMutation.addFindings[${index}].anchor.line`, 1);
      return {
        anchor: {
          ref: text(anchor.ref, `artifactMutation.addFindings[${index}].anchor.ref`, 2_048),
          ...(line === undefined ? {} : { line })
        },
        severity: oneOf(
          finding.severity,
          ["low", "medium", "high", "critical"] as const,
          `artifactMutation.addFindings[${index}].severity`
        ),
        summary: text(
          finding.summary,
          `artifactMutation.addFindings[${index}].summary`,
          2_048
        )
      };
    });
  const resolveFindingIds = array(
    mutation.resolveFindingIds,
    "artifactMutation.resolveFindingIds"
  ).map((value, index) =>
    text(value, `artifactMutation.resolveFindingIds[${index}]`, 128));
  return {
    schemaVersion: "ReviewerResult@1",
    decision: oneOf(
      root.decision,
      ["passed", "findings", "blocked"] as const,
      "ReviewerResult.decision"
    ),
    boundedSummary: text(root.boundedSummary, "ReviewerResult.boundedSummary", 4_096),
    revisionsRead: {
      subject: text(revisions.subject, "revisionsRead.subject", 256),
      ...(revisions.artifact === undefined
        ? {}
        : { artifact: text(revisions.artifact, "revisionsRead.artifact", 256) }),
      evidence: evidence(revisions.evidence)
    },
    artifactMutation: {
      addFindings,
      resolveFindingIds: [...new Set(resolveFindingIds)]
    }
  };
}

export function parseImplementerResult(output: string): ImplementerResult {
  const root = record(parse(output, "ImplementerResult"), "ImplementerResult");
  exactKeys(
    root,
    ["schemaVersion", "boundedSummary", "findingReplies", "implementationRevision"],
    "ImplementerResult"
  );
  if (root.schemaVersion !== "ImplementerResult@1") {
    throw new Error("ImplementerResult schemaVersion must be ImplementerResult@1");
  }
  const findingReplies = array(root.findingReplies, "findingReplies").map((value, index) => {
    const reply = record(value, `findingReplies[${index}]`);
    exactKeys(reply, ["findingId", "summary", "evidenceRefs"], `findingReplies[${index}]`);
    return {
      findingId: text(reply.findingId, `findingReplies[${index}].findingId`, 128),
      summary: text(reply.summary, `findingReplies[${index}].summary`, 2_048),
      evidenceRefs: array(reply.evidenceRefs, `findingReplies[${index}].evidenceRefs`)
        .map((item, evidenceIndex) =>
          text(item, `findingReplies[${index}].evidenceRefs[${evidenceIndex}]`, 2_048))
    };
  });
  return {
    schemaVersion: "ImplementerResult@1",
    boundedSummary: text(root.boundedSummary, "ImplementerResult.boundedSummary", 4_096),
    findingReplies,
    implementationRevision: text(
      root.implementationRevision,
      "ImplementerResult.implementationRevision",
      256
    )
  };
}

function evidence(value: unknown): ReviewEvidence[] {
  return array(value, "revisionsRead.evidence").map((item, index) => {
    const entry = record(item, `revisionsRead.evidence[${index}]`);
    exactKeys(entry, ["kind", "ref", "revision"], `revisionsRead.evidence[${index}]`);
    if (entry.kind !== "workspace") {
      throw new Error(`revisionsRead.evidence[${index}].kind must be workspace`);
    }
    return {
      kind: "workspace",
      ref: text(entry.ref, `revisionsRead.evidence[${index}].ref`, 2_048),
      revision: text(entry.revision, `revisionsRead.evidence[${index}].revision`, 256)
    };
  });
}

function parse(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${field} must be valid JSON: ${message(error)}`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > 500) throw new Error(`${field} exceeds 500 items`);
  return value;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} has unknown field: ${unknown[0]}`);
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
