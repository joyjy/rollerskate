import type { AgentRoomBindingRecord } from "../agent/model.js";
import type { AppendedRoomEvent, StoredRoomEventRecord } from "./model.js";

export interface EventRoomRecord {
  readonly id: string;
  readonly headSequence: number;
}

export interface EventPrincipalRecord {
  readonly principalKind: "human" | "agent";
  readonly principalId: string;
  readonly mxid: string;
}

export interface EventRepository {
  getRoom(roomId: string): Promise<EventRoomRecord | undefined>;
  getRoomByMatrixId(matrixRoomId: string): Promise<EventRoomRecord | undefined>;
  getAgentRoomBinding(
    agentId: string,
    roomId: string
  ): Promise<AgentRoomBindingRecord | undefined>;
  appendRoomEvent(input: {
    readonly roomId: string;
    readonly matrixEventId: string;
    readonly event: StoredRoomEventRecord["event"];
    readonly retainedUntil?: string;
  }): Promise<AppendedRoomEvent>;
  listRoomEvents(
    roomId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number
  ): Promise<readonly StoredRoomEventRecord[]>;
  getMatrixPrincipalByMxid(mxid: string): Promise<EventPrincipalRecord | undefined>;
  getMatrixPrincipal(
    principalKind: EventPrincipalRecord["principalKind"],
    principalId: string
  ): Promise<EventPrincipalRecord | undefined>;
  completeMatrixTransaction(transactionId: string, now: string): Promise<boolean>;
}
