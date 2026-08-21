import type { AgentWorkRequestRecord } from
  "../../../modules/work-request/model.js";
import type { WorkRequestRepository } from
  "../../../modules/work-request/repository.js";

export class MemoryWorkRequestRepository implements WorkRequestRepository {
  readonly #records = new Map<string, AgentWorkRequestRecord>();
  readonly #idempotency = new Map<string, string>();

  public async createWorkRequest(
    record: AgentWorkRequestRecord,
    maximumPendingForRequester: number
  ): Promise<"created" | "existing" | "conflict" | "pending-limit"> {
    const key = idempotencyKey(record);
    const existingId = this.#idempotency.get(key);
    if (existingId !== undefined) {
      return this.#records.get(existingId)?.requestDigest === record.requestDigest
        ? "existing"
        : "conflict";
    }
    if (isPending(record) && [...this.#records.values()].filter((candidate) =>
      candidate.value.requesterRef.kind === record.value.requesterRef.kind &&
      candidate.value.requesterRef.id === record.value.requesterRef.id &&
      isPending(candidate) &&
      Date.parse(candidate.value.expiresAt) > Date.parse(record.value.createdAt)
    ).length >= maximumPendingForRequester) {
      return "pending-limit";
    }
    this.#records.set(record.value.workRequestId, clone(record));
    this.#idempotency.set(key, record.value.workRequestId);
    return "created";
  }

  public async getWorkRequest(
    workRequestId: string
  ): Promise<AgentWorkRequestRecord | undefined> {
    const value = this.#records.get(workRequestId);
    return value === undefined ? undefined : clone(value);
  }

  public async getWorkRequestByIdempotency(
    requesterKind: "human" | "agent",
    requesterId: string,
    requestId: string
  ): Promise<AgentWorkRequestRecord | undefined> {
    const id = this.#idempotency.get(`${requesterKind}\0${requesterId}\0${requestId}`);
    return id === undefined ? undefined : this.getWorkRequest(id);
  }

  public async updateWorkRequest(
    record: AgentWorkRequestRecord,
    expectedRevision: number
  ): Promise<AgentWorkRequestRecord | undefined> {
    const current = this.#records.get(record.value.workRequestId);
    if (current?.value.revision !== expectedRevision) return undefined;
    this.#records.set(record.value.workRequestId, clone(record));
    return clone(record);
  }

  public async listRoutedWorkRequests(
    targetAgentId: string,
    routeId: string,
    limit: number
  ): Promise<readonly AgentWorkRequestRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.value.targetAgentRef.id === targetAgentId &&
        record.targetRouteId === routeId && isPending(record))
      .sort((left, right) => left.value.createdAt.localeCompare(right.value.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  public async listAcceptedWorkRequestsWithoutRun(
    targetAgentId: string,
    limit: number
  ): Promise<readonly AgentWorkRequestRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.value.targetAgentRef.id === targetAgentId &&
        record.value.status === "accepted" && record.value.runReceipt === undefined)
      .sort((left, right) => left.value.updatedAt.localeCompare(right.value.updatedAt))
      .slice(0, limit)
      .map(clone);
  }
}

function idempotencyKey(record: AgentWorkRequestRecord): string {
  return `${record.value.requesterRef.kind}\0${record.value.requesterRef.id}` +
    `\0${record.value.requestId}`;
}

function isPending(record: AgentWorkRequestRecord): boolean {
  return record.value.status === "received" || record.value.status === "awaiting-owner";
}

function clone(record: AgentWorkRequestRecord): AgentWorkRequestRecord {
  return structuredClone(record);
}
