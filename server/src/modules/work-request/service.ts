import { createHash, randomUUID } from "node:crypto";

import type {
  AgentWorkRequest,
  AgentWorkRequestCreate,
  AgentWorkRequestDecision,
  AgentWorkRequestResultSubmit,
  AgentWorkRequestRunAttach,
  AgentWorkRequestWithdraw,
  WorkRequestPrincipalRef,
  WorkRequestRouteLease,
  WorkRequestRouteReceipt
} from "@rollerskate/protocol";

import type { AgentRepository } from "../agent/repository.js";
import { ServerError } from "../shared/error.js";
import { now, type ClockOptions } from "../shared/time.js";
import type { AgentWorkRequestRecord } from "./model.js";
import type { WorkRequestRepository } from "./repository.js";
import { WorkRequestRouteRegistry } from "./route-registry.js";

const MAX_PENDING_PER_REQUESTER = 32;
const MAX_REQUEST_LIFETIME_MILLISECONDS = 7 * 86_400_000;

export class WorkRequestService {
  readonly #repository: WorkRequestRepository;
  readonly #agents: AgentRepository;
  readonly #routes: WorkRequestRouteRegistry;
  readonly #clock: ClockOptions;

  public constructor(
    repository: WorkRequestRepository,
    agents: AgentRepository,
    routes = new WorkRequestRouteRegistry(),
    clock: ClockOptions = {}
  ) {
    this.#repository = repository;
    this.#agents = agents;
    this.#routes = routes;
    this.#clock = clock;
  }

  public async create(
    requesterRef: WorkRequestPrincipalRef,
    input: AgentWorkRequestCreate
  ): Promise<{ readonly created: boolean; readonly request: AgentWorkRequest }> {
    const timestamp = now(this.#clock);
    requireFutureExpiry(input.expiresAt, timestamp);
    if (input.deadlineAt !== undefined && (
      Date.parse(input.deadlineAt) <= Date.parse(timestamp) ||
      Date.parse(input.deadlineAt) > Date.parse(input.expiresAt)
    )) {
      throw new ServerError("work_request_deadline_invalid", 400,
        "Work request deadline must be in the future and cannot exceed expiry");
    }
    const target = await this.#agents.getAgentAggregateById(input.targetAgentId);
    if (target?.agent.status !== "active" || target.placement.state !== "active") {
      throw new ServerError("target_agent_not_found", 404, "Target Agent is unavailable");
    }
    const requestDigest = digest({ requesterRef, input });
    const existing = await this.#repository.getWorkRequestByIdempotency(
      requesterRef.kind,
      requesterRef.id,
      input.requestId
    );
    if (existing !== undefined) return existingResult(existing, requestDigest);
    const route = this.#routes.active(input.targetAgentId, this.#now());
    const available = route !== undefined;
    const request: AgentWorkRequest = {
      schemaVersion: "AgentWorkRequest@1",
      workRequestId: randomUUID(),
      requesterRef,
      targetAgentRef: { kind: "agent", id: input.targetAgentId },
      requestId: input.requestId,
      objective: input.objective,
      contextRefs: input.contextRefs,
      ...(input.workflowRef === undefined ? {} : { workflowRef: input.workflowRef }),
      ...(input.requestedBudget === undefined
        ? {}
        : { requestedBudget: input.requestedBudget }),
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      requestedGrantRefs: input.requestedGrantRefs,
      resultRoute: input.resultRoute,
      expiresAt: input.expiresAt,
      status: available ? "received" : "target-unavailable",
      ...(!available ? { statusReason: "target-runtime-unavailable" } : {}),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const record: AgentWorkRequestRecord = {
      value: request,
      requestDigest,
      ...(route === undefined ? {} : { targetRouteId: route.routeId })
    };
    const outcome = await this.#repository.createWorkRequest(
      record,
      MAX_PENDING_PER_REQUESTER
    );
    if (outcome === "pending-limit") {
      throw new ServerError("work_request_pending_limit", 429,
        "Requester has too many pending work requests");
    }
    if (outcome === "conflict") {
      throw new ServerError("work_request_idempotency_conflict", 409,
        "Work request idempotency key is bound to another request");
    }
    if (outcome === "existing") {
      return existingResult((await this.#repository.getWorkRequestByIdempotency(
        requesterRef.kind,
        requesterRef.id,
        input.requestId
      ))!, requestDigest);
    }
    if (route !== undefined && !this.#routes.matches(
      input.targetAgentId,
      route.routeId,
      this.#now()
    )) {
      return {
        created: true,
        request: (await this.#cas(record, request.revision, {
          status: "target-unavailable",
          statusReason: "target-runtime-route-changed"
        })).value
      };
    }
    return { created: true, request };
  }

  public registerRoute(
    targetAgentId: string,
    input: WorkRequestRouteLease
  ): WorkRequestRouteReceipt {
    return this.#routes.register(
      targetAgentId,
      input.routeId,
      input.leaseMilliseconds,
      this.#now()
    );
  }

  public async routed(
    targetAgentId: string,
    routeId: string,
    limit = 20
  ): Promise<readonly AgentWorkRequest[]> {
    boundedLimit(limit);
    if (!this.#routes.matches(targetAgentId, routeId, this.#now())) {
      throw new ServerError("work_request_route_inactive", 409,
        "Work request route is inactive or replaced");
    }
    return this.#expireAll(await this.#repository.listRoutedWorkRequests(
      targetAgentId,
      routeId,
      limit
    ));
  }

  public async acceptedWithoutRun(
    targetAgentId: string,
    limit = 20
  ): Promise<readonly AgentWorkRequest[]> {
    boundedLimit(limit);
    return (await this.#repository.listAcceptedWorkRequestsWithoutRun(targetAgentId, limit))
      .map(({ value }) => value);
  }

  public async get(
    actor: WorkRequestPrincipalRef,
    workRequestId: string
  ): Promise<AgentWorkRequest> {
    const record = await this.#require(workRequestId);
    requireVisible(actor, record.value);
    return (await this.#expire(record)).value;
  }

  public async withdraw(
    requester: WorkRequestPrincipalRef,
    workRequestId: string,
    input: AgentWorkRequestWithdraw
  ): Promise<AgentWorkRequest> {
    const current = await this.#expire(await this.#require(workRequestId));
    requireRequester(requester, current.value);
    if (current.value.status === "withdrawn") return current.value;
    if (current.value.status !== "received" && current.value.status !== "awaiting-owner") {
      throw new ServerError("work_request_not_withdrawable", 409,
        "Work request can only be withdrawn before acceptance");
    }
    return (await this.#cas(current, input.expectedRevision, {
      status: "withdrawn",
      statusReason: "requester-withdrew"
    })).value;
  }

  public async decide(
    targetAgentId: string,
    workRequestId: string,
    input: AgentWorkRequestDecision
  ): Promise<AgentWorkRequest> {
    const current = await this.#expire(await this.#requireTarget(targetAgentId, workRequestId));
    if (current.value.decisionReceipt !== undefined &&
      digest(current.value.decisionReceipt) === digest(input.receipt)) {
      return current.value;
    }
    if (current.value.status !== "received" && current.value.status !== "awaiting-owner") {
      throw new ServerError("work_request_not_decidable", 409,
        "Work request is no longer awaiting a target decision");
    }
    validateAdmissionSubset(current.value, input);
    return (await this.#cas(current, input.expectedRevision, {
      status: input.receipt.decision,
      statusReason: input.receipt.statusReason,
      decisionReceipt: input.receipt
    })).value;
  }

  public async attachRun(
    targetAgentId: string,
    workRequestId: string,
    input: AgentWorkRequestRunAttach
  ): Promise<AgentWorkRequest> {
    const current = await this.#requireTarget(targetAgentId, workRequestId);
    if (current.value.runReceipt !== undefined) {
      if (current.value.runReceipt.runId !== input.receipt.runId) {
        throw new ServerError("work_request_run_conflict", 409,
          "Work request is already attached to another Run");
      }
      return current.value;
    }
    if (current.value.status !== "accepted") {
      throw new ServerError("work_request_not_accepted", 409,
        "Only an accepted work request can attach a Run");
    }
    return (await this.#cas(current, input.expectedRevision, {
      runReceipt: input.receipt
    })).value;
  }

  public async complete(
    targetAgentId: string,
    workRequestId: string,
    input: AgentWorkRequestResultSubmit
  ): Promise<AgentWorkRequest> {
    const current = await this.#requireTarget(targetAgentId, workRequestId);
    if (current.value.result !== undefined) {
      if (digest(current.value.result) !== digest(input.result)) {
        throw new ServerError("work_request_result_conflict", 409,
          "Work request already has another result");
      }
      return current.value;
    }
    if (current.value.status !== "accepted" || current.value.runReceipt === undefined) {
      throw new ServerError("work_request_run_required", 409,
        "Accepted work request requires its Run before completion");
    }
    return (await this.#cas(current, input.expectedRevision, {
      status: "completed",
      statusReason: input.result.outcome,
      result: input.result
    })).value;
  }

  async #expireAll(records: readonly AgentWorkRequestRecord[]): Promise<AgentWorkRequest[]> {
    const values: AgentWorkRequest[] = [];
    for (const record of records) values.push((await this.#expire(record)).value);
    return values.filter((value) => value.status === "received" || value.status === "awaiting-owner");
  }

  async #expire(record: AgentWorkRequestRecord): Promise<AgentWorkRequestRecord> {
    if ((record.value.status === "received" || record.value.status === "awaiting-owner") &&
      Date.parse(record.value.expiresAt) <= this.#now().getTime()) {
      return this.#cas(record, record.value.revision, {
        status: "expired",
        statusReason: "request-expired"
      });
    }
    return record;
  }

  async #cas(
    current: AgentWorkRequestRecord,
    expectedRevision: number,
    patch: Partial<AgentWorkRequest>
  ): Promise<AgentWorkRequestRecord> {
    if (current.value.revision !== expectedRevision) {
      throw new ServerError("work_request_revision_conflict", 409,
        "Work request revision changed");
    }
    const updated: AgentWorkRequestRecord = {
      ...current,
      value: {
        ...current.value,
        ...patch,
        revision: expectedRevision + 1,
        updatedAt: now(this.#clock)
      }
    };
    const stored = await this.#repository.updateWorkRequest(updated, expectedRevision);
    if (stored === undefined) {
      throw new ServerError("work_request_revision_conflict", 409,
        "Work request revision changed");
    }
    return stored;
  }

  async #require(workRequestId: string): Promise<AgentWorkRequestRecord> {
    const record = await this.#repository.getWorkRequest(workRequestId);
    if (record === undefined) {
      throw new ServerError("work_request_not_found", 404, "Work request was not found");
    }
    return record;
  }

  async #requireTarget(
    targetAgentId: string,
    workRequestId: string
  ): Promise<AgentWorkRequestRecord> {
    const record = await this.#require(workRequestId);
    if (record.value.targetAgentRef.id !== targetAgentId) {
      throw new ServerError("work_request_not_found", 404, "Work request was not found");
    }
    return record;
  }

  #now(): Date {
    return this.#clock.now?.() ?? new Date();
  }
}

function validateAdmissionSubset(
  request: AgentWorkRequest,
  input: AgentWorkRequestDecision
): void {
  if (input.receipt.decision !== "accepted") return;
  if (request.workflowRef !== undefined &&
    input.receipt.admittedWorkflowRef !== request.workflowRef) {
    throw new ServerError("work_request_workflow_expansion", 409,
      "Accepted workflow must match the requested workflow");
  }
  if (request.requestedBudget !== undefined && input.receipt.admittedBudget !== undefined && (
    input.receipt.admittedBudget.maxSteps > request.requestedBudget.maxSteps ||
    input.receipt.admittedBudget.maxDepth > request.requestedBudget.maxDepth
  )) {
    throw new ServerError("work_request_budget_expansion", 409,
      "Accepted budget cannot exceed the request");
  }
  const requested = new Set(request.requestedGrantRefs);
  if (input.receipt.admittedGrantRefs?.some((grant) => !requested.has(grant))) {
    throw new ServerError("work_request_grant_expansion", 409,
      "Accepted grants must be a subset of requested grants");
  }
}

function requireFutureExpiry(expiresAt: string, current: string): void {
  const duration = Date.parse(expiresAt) - Date.parse(current);
  if (duration <= 0 || duration > MAX_REQUEST_LIFETIME_MILLISECONDS) {
    throw new ServerError("work_request_expiry_invalid", 400,
      "Work request expiry must be within the next seven days");
  }
}

function requireVisible(actor: WorkRequestPrincipalRef, request: AgentWorkRequest): void {
  if ((actor.kind === request.requesterRef.kind && actor.id === request.requesterRef.id) ||
    (actor.kind === "agent" && actor.id === request.targetAgentRef.id)) return;
  throw new ServerError("work_request_not_found", 404, "Work request was not found");
}

function requireRequester(actor: WorkRequestPrincipalRef, request: AgentWorkRequest): void {
  if (actor.kind !== request.requesterRef.kind || actor.id !== request.requesterRef.id) {
    throw new ServerError("work_request_not_found", 404, "Work request was not found");
  }
}

function existingResult(
  existing: AgentWorkRequestRecord,
  requestDigest: string
): { readonly created: false; readonly request: AgentWorkRequest } {
  if (existing.requestDigest !== requestDigest) {
    throw new ServerError("work_request_idempotency_conflict", 409,
      "Work request idempotency key is bound to another request");
  }
  return { created: false, request: existing.value };
}

function boundedLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ServerError("invalid_limit", 400, "limit must be between 1 and 100");
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
