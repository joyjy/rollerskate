export type ReviewDecision = "passed" | "findings" | "blocked";
export type ReviewPhase = "reviewing" | "implementing" | "terminal";
export type ReviewRole = "reviewer" | "implementer";

export interface ReviewSubject {
  readonly kind: "acceptance";
  readonly ref: string;
  readonly revision: string;
}

export interface ReviewEvidence {
  readonly kind: "workspace";
  readonly ref: string;
  readonly revision: string;
}

export interface ReviewChainProjection {
  readonly rootEventId: string;
  readonly phase: ReviewPhase;
  readonly cycleIndex: number;
  readonly expectedEventId: string;
  readonly activeExecutionId?: string;
  readonly subjectRevision: string;
  readonly artifactRevision?: string;
  readonly implementationRevision: string;
  readonly reworkCount: number;
  readonly reworkLimit: number;
  readonly terminalDecision?: "passed" | "blocked";
  readonly terminalReason?: string;
  readonly updatedAt: string;
}
