import type { DatabaseSync } from "node:sqlite";

import {
  requireEventId,
  type AgentRequestEvent,
  type AgentResultEvent,
  type ReviewAgentInvocation,
  type ReviewDecisionEvent,
  type ReviewRequestedEvent
} from "../../core/event/model.js";
import {
  type RuntimeExecution
} from "../../core/runtime/model.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { migrateLocalDatabase } from "../../infrastructure/sqlite/local-schema.js";
import type { ReviewChainProjection } from "./model.js";

interface ProjectionRow {
  root_event_id: string;
  phase: ReviewChainProjection["phase"];
  cycle_index: number;
  expected_event_id: string;
  active_execution_id: string | null;
  subject_revision: string;
  artifact_revision: string | null;
  implementation_revision: string;
  rework_count: number;
  rework_limit: number;
  terminal_decision: "passed" | "blocked" | null;
  terminal_reason: string | null;
  updated_at: string;
}

export interface CreateReviewInput {
  readonly eventId?: string;
  readonly requestId: string;
  readonly subject: ReviewRequestedEvent["subject"];
  readonly artifactRef: string;
  readonly artifactRevision?: string;
  readonly evidence: ReviewRequestedEvent["evidence"];
  readonly implementationRevision: string;
  readonly reviewerAgentId: string;
  readonly implementerAgentId: string;
  readonly reworkLimit: number;
  readonly destinationIds?: readonly string[];
  readonly createdAt?: string;
}

export interface CreateReviewReceipt {
  readonly rootEventId: string;
  readonly executionId: string;
  readonly status: "accepted" | "duplicate";
}

type NextReviewRequest = Pick<
  ReviewRequestedEvent,
  | "cycleIndex"
  | "subject"
  | "artifactRef"
  | "artifactRevision"
  | "evidence"
  | "implementationRevision"
  | "reviewerAgentId"
  | "implementerAgentId"
  | "reworkLimit"
>;

export class ReviewStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = openRuntimeDatabase(databasePath);
    this.#migrate();
  }

  public create(input: CreateReviewInput): CreateReviewReceipt {
    void input;
    throw new Error("Legacy Review is read-only; start review@1 through Agent Run");
  }

  public projection(rootEventId: string): ReviewChainProjection | undefined {
    requireEventId(rootEventId, "rootEventId");
    const row = this.#database.prepare(`
      SELECT * FROM reviews WHERE root_event_id = ?
    `).get(rootEventId) as ProjectionRow | undefined;
    return row === undefined ? undefined : mapProjection(row);
  }

  public requireProjection(rootEventId: string): ReviewChainProjection {
    const projection = this.projection(rootEventId);
    if (projection === undefined) throw new Error(`Review chain not found: ${rootEventId}`);
    return projection;
  }

  public list(limit = 100): ReviewChainProjection[] {
    return (this.#database.prepare(`
      SELECT * FROM reviews ORDER BY updated_at DESC, root_event_id DESC LIMIT ?
    `).all(bounded(limit, 1, 1_000, "limit")) as unknown as ProjectionRow[])
      .map(mapProjection);
  }

  public eventIds(rootEventId: string): string[] {
    requireEventId(rootEventId, "rootEventId");
    return (this.#database.prepare(`
      SELECT event_id FROM events WHERE root_event_id = ?
      ORDER BY causal_hop ASC, created_at ASC, event_id ASC
    `).all(rootEventId) as unknown as Array<{ event_id: string }>)
      .map((row) => row.event_id);
  }

  public admitAgent(input: {
    readonly execution: RuntimeExecution;
    readonly parent: ReviewRequestedEvent | ReviewDecisionEvent;
    readonly invocation: ReviewAgentInvocation;
    readonly agentId: string;
    readonly prompt: string;
    readonly phase: "reviewing" | "implementing";
    readonly at?: string;
  }): { readonly eventId: string; readonly executionId: string } {
    void input;
    throw new Error("Legacy Review is read-only; Agent Run owns review@1 execution");
  }

  public recordReviewerDecision(input: {
    readonly execution: RuntimeExecution;
    readonly result: AgentResultEvent;
    readonly request: AgentRequestEvent;
    readonly requestedEventId: string;
    readonly decision: ReviewDecisionEvent["decision"];
    readonly boundedSummary: string;
    readonly revisionsRead: ReviewDecisionEvent["revisionsRead"];
    readonly artifactRevision: string;
    readonly openFindingCount: number;
    readonly blockedReason?: string;
    readonly at?: string;
  }): { readonly eventId: string; readonly executionId: string } {
    void input;
    throw new Error("Legacy Review is read-only; Agent Run owns review@1 execution");
  }

  public recordImplementation(input: {
    readonly execution: RuntimeExecution;
    readonly result: AgentResultEvent;
    readonly request: AgentRequestEvent;
    readonly next: NextReviewRequest;
    readonly at?: string;
  }): { readonly eventId: string; readonly executionId: string } {
    void input;
    throw new Error("Legacy Review is read-only; Agent Run owns review@1 execution");
  }

  public terminalize(input: {
    readonly execution: RuntimeExecution;
    readonly expectedEventId: string;
    readonly decision: "passed" | "blocked";
    readonly reason: string;
    readonly at?: string;
  }): ReviewChainProjection {
    void input;
    throw new Error("Legacy Review is read-only; Agent Run owns review@1 execution");
  }

  public recover(
    rootEventId: string,
    at = new Date().toISOString()
  ): ReviewChainProjection {
    void rootEventId;
    void at;
    throw new Error("Legacy Review is read-only; recover active work before schema v44");
  }

  public close(): void {
    this.#database.close();
  }

  #migrate(): void {
    migrateLocalDatabase(this.#database);
  }
}

function mapProjection(row: ProjectionRow): ReviewChainProjection {
  return {
    rootEventId: row.root_event_id,
    phase: row.phase,
    cycleIndex: row.cycle_index,
    expectedEventId: row.expected_event_id,
    ...(row.active_execution_id === null
      ? {}
      : { activeExecutionId: row.active_execution_id }),
    subjectRevision: row.subject_revision,
    ...(row.artifact_revision === null
      ? {}
      : { artifactRevision: row.artifact_revision }),
    implementationRevision: row.implementation_revision,
    reworkCount: row.rework_count,
    reworkLimit: row.rework_limit,
    ...(row.terminal_decision === null
      ? {}
      : { terminalDecision: row.terminal_decision }),
    ...(row.terminal_reason === null ? {} : { terminalReason: row.terminal_reason }),
    updatedAt: row.updated_at
  };
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
