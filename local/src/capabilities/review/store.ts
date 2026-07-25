import type { DatabaseSync } from "node:sqlite";

import {
  newEventId,
  requireEventId,
  type AgentRequestEvent,
  type AgentResultEvent,
  type ReviewAgentInvocation,
  type ReviewDecisionEvent,
  type ReviewRequestedEvent
} from "../../core/event/model.js";
import {
  requireRuntimeId,
  runtimeId,
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

interface ReviewTransition {
  readonly phase: "reviewing" | "implementing";
  readonly cycleIndex: number;
  readonly parentEventId: string;
  readonly childEventId: string;
  readonly childExecutionId: string;
  readonly createdAt: string;
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
    const at = iso(input.createdAt ?? new Date().toISOString());
    const eventId = input.eventId === undefined ? newEventId() : requireEventId(input.eventId);
    const executionId = runtimeId("exe");
    const requestKey = `review:${text(input.requestId, "requestId", 256).trim()}`;
    const workspaceRef = workspaceEvidence(input.evidence);
    const payload = requestedPayload({
      cycleIndex: 0,
      subject: input.subject,
      artifactRef: input.artifactRef,
      ...(input.artifactRevision === undefined
        ? {}
        : { artifactRevision: input.artifactRevision }),
      evidence: input.evidence,
      implementationRevision: input.implementationRevision,
      reviewerAgentId: input.reviewerAgentId,
      implementerAgentId: input.implementerAgentId,
      reworkLimit: bounded(input.reworkLimit, 0, 20, "reworkLimit")
    });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#database.prepare(`
        SELECT event_id FROM events
        WHERE source_kind = 'cli' AND source_external_id = ?
      `).get(requestKey) as
        { event_id: string } | undefined;
      if (duplicate !== undefined) {
        const existingExecution = this.#executionForEvent(duplicate.event_id);
        this.#database.exec("COMMIT");
        return {
          rootEventId: duplicate.event_id,
          executionId: existingExecution.execution_id,
          status: "duplicate"
        };
      }
      const active = this.#database.prepare(`
        SELECT root_event_id FROM reviews
        WHERE phase != 'terminal' AND (subject_ref = ? OR workspace_ref = ?)
      `).get(input.subject.ref, workspaceRef) as { root_event_id: string } | undefined;
      if (active !== undefined) {
        throw new Error(
          `An active Review already owns this subject or workspace: ${active.root_event_id}`
        );
      }
      this.#database.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, source_external_id, agent_id, prompt,
          outcome, output, error, payload_json, session_id, destination_ids_json,
          destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
          created_at
        ) VALUES (?, 'review.requested', 'cli', ?, NULL, NULL, NULL, NULL, NULL,
          ?, NULL, ?, ?, ?, NULL, 0, ?)
      `).run(
        eventId,
        requestKey,
        JSON.stringify(payload),
        JSON.stringify(input.destinationIds ?? []),
        JSON.stringify(this.#destinationSnapshots(input.destinationIds ?? [])),
        eventId,
        at
      );
      this.#insertExecution(executionId, eventId, "review", at);
      this.#database.prepare(`
        INSERT INTO reviews (
          root_event_id, subject_ref, workspace_ref, phase, cycle_index,
          expected_event_id, active_execution_id,
          subject_revision, artifact_revision, implementation_revision,
          rework_count, rework_limit, terminal_decision, terminal_reason,
          reviewer_session_id, implementer_session_id, transitions_json, updated_at
        ) VALUES (
          ?, ?, ?, 'reviewing', 0, ?, ?, ?, ?, ?, 0, ?, NULL, NULL,
          NULL, NULL, '[]', ?
        )
      `).run(
        eventId,
        input.subject.ref,
        workspaceRef,
        eventId,
        executionId,
        input.subject.revision,
        input.artifactRevision ?? null,
        input.implementationRevision,
        input.reworkLimit,
        at
      );
      this.#database.exec("COMMIT");
      return { rootEventId: eventId, executionId, status: "accepted" };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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
    const at = iso(input.at ?? new Date().toISOString());
    const rootEventId = input.parent.causality.rootEventId;
    const childEventId = newEventId();
    const childExecutionId = runtimeId("exe");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireRunningReviewExecution(input.execution, input.parent.eventId);
      const projection = this.requireProjection(rootEventId);
      if (projection.expectedEventId !== input.parent.eventId ||
        projection.activeExecutionId !== input.execution.executionId) {
        throw new Error(`Review projection does not expect Event: ${input.parent.eventId}`);
      }
      const existing = this.#transition(
        rootEventId,
        input.phase,
        input.invocation.cycleIndex
      );
      if (existing !== undefined) {
        this.#database.exec("COMMIT");
        return {
          eventId: existing.childEventId,
          executionId: existing.childExecutionId
        };
      }
      const sessionId = this.#roleSession(rootEventId, input.invocation.role);
      this.#database.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, source_external_id, agent_id, prompt,
          outcome, output, error, payload_json, session_id, destination_ids_json,
          destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
          created_at
        ) VALUES (?, 'agent.request', 'handler', ?, ?, ?, NULL, NULL, NULL, ?, ?,
          '[]', '[]', ?, ?, ?, ?)
      `).run(
        childEventId,
        `review-agent:${rootEventId}:${input.phase}:${input.invocation.cycleIndex}`,
        input.agentId,
        text(input.prompt, "prompt", 16_384),
        JSON.stringify(input.invocation),
        sessionId,
        rootEventId,
        input.parent.eventId,
        input.parent.causality.hop + 1,
        at
      );
      this.#insertExecution(childExecutionId, childEventId, "agent", at);
      this.#completeExecution(input.execution.executionId, at);
      this.#appendTransition(rootEventId, {
        phase: input.phase,
        cycleIndex: input.invocation.cycleIndex,
        parentEventId: input.parent.eventId,
        childEventId,
        childExecutionId,
        createdAt: at
      });
      const changed = this.#database.prepare(`
        UPDATE reviews SET phase = ?, expected_event_id = ?,
          active_execution_id = ?, artifact_revision = ?, updated_at = ?
        WHERE root_event_id = ? AND expected_event_id = ? AND active_execution_id = ?
      `).run(
        input.phase,
        childEventId,
        childExecutionId,
        input.invocation.artifactRevision ?? null,
        at,
        rootEventId,
        input.parent.eventId,
        input.execution.executionId
      );
      if (changed.changes !== 1) throw new Error(`Review projection CAS failed: ${rootEventId}`);
      this.#database.exec("COMMIT");
      return { eventId: childEventId, executionId: childExecutionId };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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
    const at = iso(input.at ?? new Date().toISOString());
    const rootEventId = input.result.causality.rootEventId;
    const eventId = newEventId();
    const executionId = runtimeId("exe");
    const payload = {
      cycleIndex: input.request.reviewInvocation!.cycleIndex,
      requestedEventId: input.requestedEventId,
      reviewerResultEventId: input.result.eventId,
      decision: input.decision,
      boundedSummary: text(input.boundedSummary, "boundedSummary", 4_096),
      revisionsRead: input.revisionsRead,
      artifactRevision: text(input.artifactRevision, "artifactRevision", 256),
      openFindingCount: bounded(input.openFindingCount, 0, 10_000, "openFindingCount"),
      ...(input.blockedReason === undefined
        ? {}
        : { blockedReason: text(input.blockedReason, "blockedReason", 4_096) })
    };
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireRunningResultExecution(input.execution, input.result.eventId);
      const projection = this.requireProjection(rootEventId);
      const parentExecution = this.#executionForEvent(input.request.eventId);
      if (projection.expectedEventId !== input.request.eventId ||
        projection.activeExecutionId !== parentExecution.execution_id) {
        throw new Error(`Review projection does not expect Reviewer result: ${input.result.eventId}`);
      }
      this.#database.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, source_external_id, agent_id, prompt,
          outcome, output, error, payload_json, session_id, destination_ids_json,
          destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
          created_at
        ) VALUES (?, 'review.decision', 'handler', ?, NULL, NULL, NULL, NULL, NULL,
          ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        `review-decision:${input.result.eventId}`,
        JSON.stringify(payload),
        JSON.stringify(this.#rootDestinationIds(rootEventId)),
        this.#rootDestinationSnapshots(rootEventId),
        rootEventId,
        input.result.eventId,
        input.result.causality.hop + 1,
        at
      );
      this.#insertExecution(executionId, eventId, "review", at);
      this.#rememberRoleSession(rootEventId, "reviewer", input.result.sessionId, at);
      this.#completeExecution(input.execution.executionId, at);
      const changed = this.#database.prepare(`
        UPDATE reviews SET expected_event_id = ?, active_execution_id = ?,
          artifact_revision = ?, updated_at = ?
        WHERE root_event_id = ? AND expected_event_id = ? AND active_execution_id = ?
      `).run(
        eventId,
        executionId,
        input.artifactRevision,
        at,
        rootEventId,
        input.request.eventId,
        parentExecution.execution_id
      );
      if (changed.changes !== 1) throw new Error(`Review projection CAS failed: ${rootEventId}`);
      this.#database.exec("COMMIT");
      return { eventId, executionId };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public recordImplementation(input: {
    readonly execution: RuntimeExecution;
    readonly result: AgentResultEvent;
    readonly request: AgentRequestEvent;
    readonly next: NextReviewRequest;
    readonly at?: string;
  }): { readonly eventId: string; readonly executionId: string } {
    const at = iso(input.at ?? new Date().toISOString());
    const rootEventId = input.result.causality.rootEventId;
    const eventId = newEventId();
    const executionId = runtimeId("exe");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireRunningResultExecution(input.execution, input.result.eventId);
      const projection = this.requireProjection(rootEventId);
      const parentExecution = this.#executionForEvent(input.request.eventId);
      if (projection.phase !== "implementing" ||
        projection.expectedEventId !== input.request.eventId ||
        projection.activeExecutionId !== parentExecution.execution_id) {
        throw new Error(
          `Review projection does not expect Implementer result: ${input.result.eventId}`
        );
      }
      this.#database.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, source_external_id, agent_id, prompt,
          outcome, output, error, payload_json, session_id, destination_ids_json,
          destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
          created_at
        ) VALUES (?, 'review.requested', 'handler', ?, NULL, NULL, NULL, NULL, NULL,
          ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        `review-request:${input.result.eventId}`,
        JSON.stringify(requestedPayload(input.next)),
        JSON.stringify(this.#rootDestinationIds(rootEventId)),
        this.#rootDestinationSnapshots(rootEventId),
        rootEventId,
        input.result.eventId,
        input.result.causality.hop + 1,
        at
      );
      this.#insertExecution(executionId, eventId, "review", at);
      this.#rememberRoleSession(rootEventId, "implementer", input.result.sessionId, at);
      this.#completeExecution(input.execution.executionId, at);
      const changed = this.#database.prepare(`
        UPDATE reviews SET phase = 'reviewing', cycle_index = ?,
          expected_event_id = ?, active_execution_id = ?, artifact_revision = ?,
          implementation_revision = ?, rework_count = rework_count + 1, updated_at = ?
        WHERE root_event_id = ? AND phase = 'implementing'
          AND expected_event_id = ? AND active_execution_id = ?
      `).run(
        input.next.cycleIndex,
        eventId,
        executionId,
        input.next.artifactRevision ?? null,
        input.next.implementationRevision,
        at,
        rootEventId,
        input.request.eventId,
        parentExecution.execution_id
      );
      if (changed.changes !== 1) throw new Error(`Review projection CAS failed: ${rootEventId}`);
      this.#database.exec("COMMIT");
      return { eventId, executionId };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public terminalize(input: {
    readonly execution: RuntimeExecution;
    readonly expectedEventId: string;
    readonly decision: "passed" | "blocked";
    readonly reason: string;
    readonly at?: string;
  }): ReviewChainProjection {
    const at = iso(input.at ?? new Date().toISOString());
    const rootEventId = this.#eventRoot(input.expectedEventId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const projection = this.requireProjection(rootEventId);
      if (projection.expectedEventId !== input.expectedEventId) {
        throw new Error(`Review projection does not expect Event: ${input.expectedEventId}`);
      }
      if (input.execution.status !== "running") {
        throw new Error(`Review terminal Execution is not running: ${input.execution.executionId}`);
      }
      this.#completeExecution(input.execution.executionId, at);
      const changed = this.#database.prepare(`
        UPDATE reviews SET phase = 'terminal', active_execution_id = NULL,
          terminal_decision = ?, terminal_reason = ?, updated_at = ?
        WHERE root_event_id = ? AND expected_event_id = ?
      `).run(
        input.decision,
        text(input.reason, "reason", 4_096),
        at,
        rootEventId,
        input.expectedEventId
      );
      if (changed.changes !== 1) throw new Error(`Review projection CAS failed: ${rootEventId}`);
      this.#database.exec("COMMIT");
      return this.requireProjection(rootEventId);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public recover(
    rootEventId: string,
    at = new Date().toISOString()
  ): ReviewChainProjection {
    const timestamp = iso(at);
    const projection = this.requireProjection(rootEventId);
    if (projection.phase === "terminal") return projection;
    const execution = this.#executionForEvent(projection.expectedEventId);
    if (execution.status === "queued" || execution.status === "retry_wait") return projection;
    if (execution.status === "running") {
      throw new Error("Review has a running Execution; run global recover while the loop is stopped");
    }
    this.#database.prepare(`
      UPDATE reviews SET phase = 'terminal', active_execution_id = NULL,
        terminal_decision = 'blocked', terminal_reason = ?, updated_at = ?
      WHERE root_event_id = ? AND phase != 'terminal' AND expected_event_id = ?
    `).run(
      `expected Execution is ${execution.status}: ${execution.execution_id}`,
      timestamp,
      rootEventId,
      projection.expectedEventId
    );
    return this.requireProjection(rootEventId);
  }

  public close(): void {
    this.#database.close();
  }

  #migrate(): void {
    migrateLocalDatabase(this.#database);
  }

  #insertExecution(
    executionId: string,
    eventId: string,
    handler: "agent" | "review",
    at: string
  ): void {
    this.#database.prepare(`
      INSERT INTO executions (
        execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, 3, ?, ?, ?)
    `).run(executionId, eventId, handler, at, at, at);
  }

  #completeExecution(executionId: string, at: string): void {
    const changed = this.#database.prepare(`
      UPDATE executions SET status = 'succeeded', completed_at = ?,
        updated_at = ?, last_error = NULL
      WHERE execution_id = ? AND status = 'running'
    `).run(at, at, executionId);
    if (changed.changes !== 1) throw new Error(`Execution is not running: ${executionId}`);
  }

  #requireRunningReviewExecution(execution: RuntimeExecution, eventId: string): void {
    if (execution.handler !== "review" || execution.status !== "running" ||
      execution.eventId !== eventId) {
      throw new Error(`Review Execution does not match Event: ${eventId}`);
    }
  }

  #requireRunningResultExecution(execution: RuntimeExecution, eventId: string): void {
    if (execution.handler !== "result" || execution.status !== "running" ||
      execution.eventId !== eventId) {
      throw new Error(`Result Execution does not match Event: ${eventId}`);
    }
  }

  #executionForEvent(eventId: string): {
    readonly execution_id: string;
    readonly status: RuntimeExecution["status"];
  } {
    const row = this.#database.prepare(`
      SELECT execution_id, status FROM executions WHERE event_id = ?
    `).get(eventId) as {
      execution_id: string;
      status: RuntimeExecution["status"];
    } | undefined;
    if (row === undefined) throw new Error(`Event has no Execution: ${eventId}`);
    return row;
  }

  #eventRoot(eventId: string): string {
    const row = this.#database.prepare(`
      SELECT root_event_id FROM events WHERE event_id = ?
    `).get(eventId) as { root_event_id: string } | undefined;
    if (row === undefined) throw new Error(`Event not found: ${eventId}`);
    return row.root_event_id;
  }

  #rootDestinationIds(rootEventId: string): string[] {
    const row = this.#database.prepare(`
      SELECT destination_ids_json FROM events WHERE event_id = ?
    `).get(rootEventId) as { destination_ids_json: string } | undefined;
    if (row === undefined) throw new Error(`Review root Event not found: ${rootEventId}`);
    const value = JSON.parse(row.destination_ids_json) as unknown;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`Review root destinations are malformed: ${rootEventId}`);
    }
    return value as string[];
  }

  #rootDestinationSnapshots(rootEventId: string): string {
    const row = this.#database.prepare(`
      SELECT destination_snapshots_json FROM events WHERE event_id = ?
    `).get(rootEventId) as { destination_snapshots_json: string } | undefined;
    if (row === undefined) throw new Error(`Review root Event not found: ${rootEventId}`);
    return row.destination_snapshots_json;
  }

  #destinationSnapshots(
    destinationIds: readonly string[]
  ): readonly Readonly<Record<string, unknown>>[] {
    return destinationIds.map((destinationId) => {
      requireRuntimeId(destinationId, "dst", "destinationId");
      const delivery = this.#database.prepare(`
        SELECT destination_kind, destination_address_json, created_at, updated_at
        FROM deliveries
        WHERE destination_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(destinationId) as {
        destination_kind: "matrix" | "macos-notification";
        destination_address_json: string;
        created_at: string;
        updated_at: string;
      } | undefined;
      if (delivery !== undefined) {
        return {
          destinationId,
          kind: delivery.destination_kind,
          address: JSON.parse(delivery.destination_address_json) as unknown,
          createdAt: delivery.created_at,
          updatedAt: delivery.updated_at
        };
      }
      const events = this.#database.prepare(`
        SELECT destination_snapshots_json
        FROM events
        WHERE destination_snapshots_json != '[]'
        ORDER BY created_at DESC
      `).all() as unknown as Array<{ destination_snapshots_json: string }>;
      for (const event of events) {
        const snapshots = JSON.parse(event.destination_snapshots_json) as unknown;
        if (!Array.isArray(snapshots)) continue;
        const snapshot = snapshots.find((entry) =>
          isRecord(entry) && entry.destinationId === destinationId);
        if (isRecord(snapshot)) return snapshot;
      }
      throw new Error(`Destination snapshot not found: ${destinationId}`);
    });
  }

  #transition(
    rootEventId: string,
    phase: ReviewTransition["phase"],
    cycleIndex: number
  ): ReviewTransition | undefined {
    return this.#transitions(rootEventId).find((transition) =>
      transition.phase === phase && transition.cycleIndex === cycleIndex);
  }

  #appendTransition(rootEventId: string, transition: ReviewTransition): void {
    const transitions = this.#transitions(rootEventId);
    if (transitions.some((candidate) =>
      candidate.phase === transition.phase &&
      candidate.cycleIndex === transition.cycleIndex)) {
      return;
    }
    const result = this.#database.prepare(`
      UPDATE reviews SET transitions_json = ? WHERE root_event_id = ?
    `).run(JSON.stringify([...transitions, transition]), rootEventId);
    if (result.changes !== 1) throw new Error(`Review chain not found: ${rootEventId}`);
  }

  #transitions(rootEventId: string): ReviewTransition[] {
    const row = this.#database.prepare(`
      SELECT transitions_json FROM reviews WHERE root_event_id = ?
    `).get(rootEventId) as { transitions_json: string } | undefined;
    if (row === undefined) throw new Error(`Review chain not found: ${rootEventId}`);
    const value = JSON.parse(row.transitions_json) as unknown;
    if (!Array.isArray(value)) throw new Error(`Review transitions are malformed: ${rootEventId}`);
    return value.map((entry) => {
      if (!isRecord(entry) ||
        (entry.phase !== "reviewing" && entry.phase !== "implementing") ||
        typeof entry.cycleIndex !== "number" ||
        typeof entry.parentEventId !== "string" ||
        typeof entry.childEventId !== "string" ||
        typeof entry.childExecutionId !== "string" ||
        typeof entry.createdAt !== "string") {
        throw new Error(`Review transition is malformed: ${rootEventId}`);
      }
      return {
        phase: entry.phase,
        cycleIndex: entry.cycleIndex,
        parentEventId: entry.parentEventId,
        childEventId: entry.childEventId,
        childExecutionId: entry.childExecutionId,
        createdAt: entry.createdAt
      };
    });
  }

  #roleSession(rootEventId: string, role: "reviewer" | "implementer"): string | null {
    const row = this.#database.prepare(`
      SELECT reviewer_session_id, implementer_session_id
      FROM reviews
      WHERE root_event_id = ?
    `).get(rootEventId) as {
      reviewer_session_id: string | null;
      implementer_session_id: string | null;
    } | undefined;
    return role === "reviewer"
      ? row?.reviewer_session_id ?? null
      : row?.implementer_session_id ?? null;
  }

  #rememberRoleSession(
    rootEventId: string,
    role: "reviewer" | "implementer",
    sessionId: string | undefined,
    at: string
  ): void {
    if (sessionId === undefined) return;
    requireRuntimeId(sessionId, "ses", "sessionId");
    const column = role === "reviewer"
      ? "reviewer_session_id"
      : "implementer_session_id";
    this.#database.prepare(`
      UPDATE reviews SET ${column} = ?, updated_at = ? WHERE root_event_id = ?
    `).run(sessionId, at, rootEventId);
  }
}

function requestedPayload(
  input: Pick<
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
  >
): Readonly<Record<string, unknown>> {
  return {
    cycleIndex: input.cycleIndex,
    subject: input.subject,
    artifactRef: input.artifactRef,
    ...(input.artifactRevision === undefined
      ? {}
      : { artifactRevision: input.artifactRevision }),
    evidence: input.evidence,
    implementationRevision: input.implementationRevision,
    reviewerAgentId: input.reviewerAgentId,
    implementerAgentId: input.implementerAgentId,
    reworkLimit: input.reworkLimit
  };
}

function workspaceEvidence(
  evidence: ReviewRequestedEvent["evidence"]
): string {
  if (evidence.length !== 1 || evidence[0]?.kind !== "workspace") {
    throw new Error("Review requires exactly one workspace evidence ref");
  }
  return text(evidence[0].ref, "evidence.workspace.ref", 4_096);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function text(value: string, field: string, maximum: number): string {
  if (value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return value;
}

function iso(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("timestamp must be RFC3339");
  return new Date(value).toISOString();
}
