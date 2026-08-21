import type { AgentWorkRequestRecord } from "./model.js";

export interface WorkRequestRepository {
  createWorkRequest(
    record: AgentWorkRequestRecord,
    maximumPendingForRequester: number
  ): Promise<"created" | "existing" | "conflict" | "pending-limit">;
  getWorkRequest(workRequestId: string): Promise<AgentWorkRequestRecord | undefined>;
  getWorkRequestByIdempotency(
    requesterKind: "human" | "agent",
    requesterId: string,
    requestId: string
  ): Promise<AgentWorkRequestRecord | undefined>;
  updateWorkRequest(
    record: AgentWorkRequestRecord,
    expectedRevision: number
  ): Promise<AgentWorkRequestRecord | undefined>;
  listRoutedWorkRequests(
    targetAgentId: string,
    routeId: string,
    limit: number
  ): Promise<readonly AgentWorkRequestRecord[]>;
  listAcceptedWorkRequestsWithoutRun(
    targetAgentId: string,
    limit: number
  ): Promise<readonly AgentWorkRequestRecord[]>;
}
