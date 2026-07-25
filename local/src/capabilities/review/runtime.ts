import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import {
  applyImplementerResult,
  applyReviewerResult,
  createReviewArtifact,
  readReviewArtifact,
  writeReviewArtifact,
  type ReviewArtifact
} from "./artifact-schema.js";
import {
  parseImplementerResult,
  parseReviewerResult
} from "./result-contract.js";
import {
  renderImplementerPrompt,
  renderReviewerPrompt
} from "./prompt-resource.js";
import { fileRevision, workspaceRevision } from "./workspace-revision.js";
import type {
  AgentRequestEvent,
  AgentResultEvent,
  ReviewAgentInvocation,
  ReviewDecisionEvent,
  ReviewRequestedEvent
} from "../../core/event/model.js";
import type {
  RuntimeAgentAdapter,
  RuntimeReviewContinuation
} from "../../core/runtime/handlers.js";
import type { RuntimeExecution } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { ReviewStore } from "./store.js";

export class ReviewRuntime implements RuntimeReviewContinuation {
  public readonly kind = "review" as const;
  readonly #adapterForAgent: (
    agentId: string,
    workspace: string
  ) => RuntimeAgentAdapter | undefined;
  readonly #runtime: RuntimeStore;
  readonly #store: ReviewStore;

  public constructor(options: {
    readonly store: ReviewStore;
    readonly runtime: RuntimeStore;
    readonly adapterForAgent: (
      agentId: string,
      workspace: string
    ) => RuntimeAgentAdapter | undefined;
  }) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#adapterForAgent = options.adapterForAgent;
  }

  public handle(
    execution: RuntimeExecution,
    at = new Date().toISOString()
  ): void {
    if (execution.handler !== "review" || execution.status !== "running") {
      throw new Error(`ReviewRuntime cannot process Execution: ${execution.executionId}`);
    }
    const event = this.#runtime.event(execution.eventId);
    try {
      if (event?.type === "review.requested") {
        this.#handleRequested(execution, event, at);
        return;
      }
      if (event?.type === "review.decision") {
        this.#handleDecision(execution, event, at);
        return;
      }
      throw new Error(`ReviewRuntime requires a Review Event: ${execution.eventId}`);
    } catch (error) {
      this.#store.terminalize({
        execution,
        expectedEventId: execution.eventId,
        decision: "blocked",
        reason: `Review admission failed: ${message(error)}`,
        at
      });
    }
  }

  public handleAgentResult(
    execution: RuntimeExecution,
    result: AgentResultEvent,
    request: AgentRequestEvent,
    at: string
  ): boolean {
    const invocation = request.reviewInvocation;
    if (invocation === undefined) return false;
    try {
      if (result.outcome !== "succeeded" || result.output === undefined) {
        this.#store.terminalize({
          execution,
          expectedEventId: request.eventId,
          decision: "blocked",
          reason: `agent invocation failed: ${result.error ?? "unknown error"}`,
          at
        });
        return true;
      }
      if (invocation.role === "reviewer") {
        this.#handleReviewerResult(execution, result, request, invocation, at);
      } else {
        this.#handleImplementerResult(execution, result, request, invocation, at);
      }
    } catch (error) {
      this.#store.terminalize({
        execution,
        expectedEventId: request.eventId,
        decision: "blocked",
        reason: `invalid ${invocation.role} result: ${message(error)}`,
        at
      });
    }
    return true;
  }

  #handleRequested(
    execution: RuntimeExecution,
    event: ReviewRequestedEvent,
    at: string
  ): void {
    const workspace = requireWorkspaceEvidence(event);
    const artifact = this.#validateRequestedState(event, workspace.ref);
    this.#requireCapability(
      event.reviewerAgentId,
      workspace.ref,
      "ReviewerResult@1",
      "read"
    );
    this.#requireCapability(
      event.implementerAgentId,
      workspace.ref,
      "ImplementerResult@1",
      "write"
    );
    const invocation: ReviewAgentInvocation = {
      schemaVersion: "review-invocation@1",
      role: "reviewer",
      rootEventId: event.causality.rootEventId,
      cycleIndex: event.cycleIndex,
      subject: event.subject,
      artifactRef: event.artifactRef,
      artifactRevision: artifact.artifactRevision,
      evidence: event.evidence,
      implementationRevision: event.implementationRevision,
      workspaceAccess: "read",
      resultSchema: "ReviewerResult@1"
    };
    this.#store.admitAgent({
      execution,
      parent: event,
      invocation,
      agentId: event.reviewerAgentId,
      prompt: renderReviewerPrompt(invocation),
      phase: "reviewing",
      at
    });
  }

  #handleDecision(
    execution: RuntimeExecution,
    event: ReviewDecisionEvent,
    at: string
  ): void {
    const projection = this.#store.requireProjection(event.causality.rootEventId);
    if (event.decision === "passed") {
      if (event.openFindingCount !== 0) {
        throw new Error("passed Review decision has open findings");
      }
      this.#store.terminalize({
        execution,
        expectedEventId: event.eventId,
        decision: "passed",
        reason: event.boundedSummary,
        at
      });
      return;
    }
    if (event.decision === "blocked") {
      this.#store.terminalize({
        execution,
        expectedEventId: event.eventId,
        decision: "blocked",
        reason: event.blockedReason ?? event.boundedSummary,
        at
      });
      return;
    }
    if (event.openFindingCount < 1) {
      throw new Error("findings Review decision has no open findings");
    }
    if (projection.reworkCount >= projection.reworkLimit) {
      this.#store.terminalize({
        execution,
        expectedEventId: event.eventId,
        decision: "blocked",
        reason: "rework limit exhausted",
        at
      });
      return;
    }
    const root = this.#rootRequest(event.causality.rootEventId);
    const workspace = requireWorkspaceEvidence(root);
    this.#validateArtifact(root.artifactRef, event.artifactRevision);
    this.#validateWorkspace(workspace.ref, projection.implementationRevision);
    this.#requireCapability(
      root.implementerAgentId,
      workspace.ref,
      "ImplementerResult@1",
      "write"
    );
    const invocation: ReviewAgentInvocation = {
      schemaVersion: "review-invocation@1",
      role: "implementer",
      rootEventId: event.causality.rootEventId,
      cycleIndex: event.cycleIndex,
      subject: root.subject,
      artifactRef: root.artifactRef,
      artifactRevision: event.artifactRevision,
      evidence: root.evidence.map((evidence) => ({
        ...evidence,
        revision: projection.implementationRevision
      })),
      implementationRevision: projection.implementationRevision,
      workspaceAccess: "write",
      writableRoot: workspace.ref,
      resultSchema: "ImplementerResult@1"
    };
    this.#store.admitAgent({
      execution,
      parent: event,
      invocation,
      agentId: root.implementerAgentId,
      prompt: renderImplementerPrompt(invocation),
      phase: "implementing",
      at
    });
  }

  #handleReviewerResult(
    execution: RuntimeExecution,
    resultEvent: AgentResultEvent,
    request: AgentRequestEvent,
    invocation: ReviewAgentInvocation,
    at: string
  ): void {
    const result = parseReviewerResult(resultEvent.output!);
    validateReviewerReads(invocation, result.revisionsRead);
    if (fileRevision(invocation.subject.ref) !== invocation.subject.revision) {
      throw new Error("subject revision changed during Reviewer invocation");
    }
    this.#validateWorkspace(
      requireWorkspaceEvidenceFromInvocation(invocation).ref,
      invocation.implementationRevision
    );
    const artifact = this.#artifactForInvocation(invocation);
    validateFindingAnchors(
      requireWorkspaceEvidenceFromInvocation(invocation).ref,
      result.artifactMutation.addFindings
    );
    const updated = applyReviewerResult(
      artifact,
      result,
      request.agentId,
      invocation.cycleIndex,
      at
    );
    const openFindingCount = updated.findings.filter((finding) => finding.status === "open").length;
    if (result.decision === "passed" && (openFindingCount !== 0 ||
      result.artifactMutation.addFindings.length !== 0)) {
      throw new Error("passed decision cannot leave or add open findings");
    }
    if (result.decision === "findings" && (openFindingCount === 0 ||
      updated.artifactRevision === artifact.artifactRevision)) {
      throw new Error("findings decision must mutate the artifact and leave open findings");
    }
    if (updated.artifactRevision !== artifact.artifactRevision) {
      writeReviewArtifact(invocation.artifactRef, updated);
    }
    const requestedEventId = request.causality.parentEventId;
    if (requestedEventId === undefined) throw new Error("Reviewer request has no parent");
    this.#store.recordReviewerDecision({
      execution,
      result: resultEvent,
      request,
      requestedEventId,
      decision: result.decision,
      boundedSummary: result.boundedSummary,
      revisionsRead: result.revisionsRead,
      artifactRevision: updated.artifactRevision,
      openFindingCount,
      ...(result.decision === "blocked"
        ? { blockedReason: result.boundedSummary }
        : {}),
      at
    });
  }

  #handleImplementerResult(
    execution: RuntimeExecution,
    resultEvent: AgentResultEvent,
    request: AgentRequestEvent,
    invocation: ReviewAgentInvocation,
    at: string
  ): void {
    const result = parseImplementerResult(resultEvent.output!);
    const workspace = requireWorkspaceEvidenceFromInvocation(invocation);
    const currentWorkspace = workspaceRevision(workspace.ref);
    if (currentWorkspace.revision !== result.implementationRevision) {
      throw new Error("Implementer result does not match current workspace revision");
    }
    if (result.implementationRevision === invocation.implementationRevision) {
      throw new Error("Implementer did not produce a new workspace revision");
    }
    const artifact = this.#artifactForInvocation(invocation);
    const updated = applyImplementerResult(
      artifact,
      result,
      request.agentId,
      at
    );
    if (updated.artifactRevision === artifact.artifactRevision) {
      throw new Error("Implementer must reply to at least one open finding");
    }
    writeReviewArtifact(invocation.artifactRef, updated);
    const root = this.#rootRequest(invocation.rootEventId);
    this.#store.recordImplementation({
      execution,
      result: resultEvent,
      request,
      next: {
        cycleIndex: invocation.cycleIndex + 1,
        subject: root.subject,
        artifactRef: root.artifactRef,
        artifactRevision: updated.artifactRevision,
        evidence: root.evidence.map((evidence) => ({
          ...evidence,
          revision: result.implementationRevision
        })),
        implementationRevision: result.implementationRevision,
        reviewerAgentId: root.reviewerAgentId,
        implementerAgentId: root.implementerAgentId,
        reworkLimit: root.reworkLimit
      },
      at
    });
  }

  #validateRequestedState(
    event: ReviewRequestedEvent,
    workspace: string
  ): ReviewArtifact {
    if (fileRevision(event.subject.ref) !== event.subject.revision) {
      throw new Error("Review subject revision does not match current content");
    }
    this.#validateWorkspace(workspace, event.implementationRevision);
    const evidence = requireWorkspaceEvidence(event);
    if (evidence.revision !== event.implementationRevision) {
      throw new Error("workspace evidence and implementation revision do not match");
    }
    const existing = readReviewArtifact(event.artifactRef);
    if (existing === undefined) {
      if (event.artifactRevision !== undefined) throw new Error("review artifact is missing");
      const created = createReviewArtifact({
        subjectRef: event.subject.ref,
        subjectRevision: event.subject.revision,
        rootReviewId: event.causality.rootEventId
      });
      return writeReviewArtifact(event.artifactRef, created);
    }
    if (existing.artifactRevision !== event.artifactRevision &&
      !(event.artifactRevision === undefined &&
        existing.rootReviewId === event.causality.rootEventId)) {
      throw new Error("review artifact revision does not match Review Event");
    }
    return existing;
  }

  #validateWorkspace(workspace: string, expectedRevision: string): void {
    if (workspaceRevision(workspace).revision !== expectedRevision) {
      throw new Error("workspace revision changed outside the Review chain");
    }
  }

  #validateArtifact(path: string, expectedRevision: string | undefined): void {
    const artifact = readReviewArtifact(path);
    if (artifact === undefined) {
      if (expectedRevision !== undefined) throw new Error("review artifact is missing");
      return;
    }
    if (expectedRevision === undefined || artifact.artifactRevision !== expectedRevision) {
      throw new Error("review artifact revision does not match Review Event");
    }
  }

  #artifactForInvocation(invocation: ReviewAgentInvocation): ReviewArtifact {
    const artifact = readReviewArtifact(invocation.artifactRef);
    if (artifact === undefined) throw new Error("review artifact is missing");
    if (artifact.subject.ref !== invocation.subject.ref ||
      artifact.subject.revision !== invocation.subject.revision ||
      artifact.rootReviewId !== invocation.rootEventId ||
      artifact.artifactRevision !== invocation.artifactRevision) {
      throw new Error("review artifact does not match invocation");
    }
    return artifact;
  }

  #requireCapability(
    agentId: string,
    workspace: string,
    resultSchema: "ReviewerResult@1" | "ImplementerResult@1",
    access: "read" | "write"
  ): void {
    const adapter = this.#adapterForAgent(agentId, workspace);
    if (adapter === undefined) throw new Error(`Review Agent adapter not available: ${agentId}`);
    if (adapter.workspace !== workspace ||
      adapter.reviewCapabilities?.resultSchemas.includes(resultSchema) !== true ||
      adapter.reviewCapabilities.workspaceAccess.includes(access) !== true) {
      throw new Error(
        `Agent adapter does not support ${resultSchema} + workspace ${access}: ${agentId}`
      );
    }
  }

  #rootRequest(rootEventId: string): ReviewRequestedEvent {
    const event = this.#runtime.event(rootEventId);
    if (event?.type !== "review.requested") {
      throw new Error(`Review root request not found: ${rootEventId}`);
    }
    return event;
  }
}

function validateReviewerReads(
  invocation: ReviewAgentInvocation,
  revisionsRead: import("./result-contract.js").ReviewerResult["revisionsRead"]
): void {
  if (revisionsRead.subject !== invocation.subject.revision ||
    revisionsRead.artifact !== invocation.artifactRevision ||
    JSON.stringify(revisionsRead.evidence) !== JSON.stringify(invocation.evidence)) {
    throw new Error("Reviewer did not read the fixed revisions");
  }
}

function validateFindingAnchors(
  workspaceInput: string,
  findings: import("./result-contract.js").ReviewerResult["artifactMutation"]["addFindings"]
): void {
  const workspace = realpathSync(workspaceInput);
  for (const [index, finding] of findings.entries()) {
    if (!isAbsolute(finding.anchor.ref)) {
      throw new Error(`finding anchor must be absolute: ${index}`);
    }
    const anchor = realpathSync(finding.anchor.ref);
    const child = relative(workspace, anchor);
    if (child === ".." || child.startsWith(`..${sep}`)) {
      throw new Error(`finding anchor is outside workspace authority: ${finding.anchor.ref}`);
    }
    if (!statSync(anchor).isFile()) {
      throw new Error(`finding anchor is not a file: ${finding.anchor.ref}`);
    }
  }
}

function requireWorkspaceEvidence(event: ReviewRequestedEvent): {
  readonly kind: "workspace";
  readonly ref: string;
  readonly revision: string;
} {
  if (event.evidence.length !== 1 || event.evidence[0]?.kind !== "workspace") {
    throw new Error("acceptance Review requires exactly one workspace evidence ref");
  }
  return event.evidence[0];
}

function requireWorkspaceEvidenceFromInvocation(invocation: ReviewAgentInvocation): {
  readonly kind: "workspace";
  readonly ref: string;
  readonly revision: string;
} {
  if (invocation.evidence.length !== 1 || invocation.evidence[0]?.kind !== "workspace") {
    throw new Error("Review invocation requires exactly one workspace evidence ref");
  }
  return invocation.evidence[0];
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 3_900);
}
