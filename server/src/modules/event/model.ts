import type { EventEnvelope, RoomEventProjection } from "@rollerskate/protocol";

import type { AgentRoomBindingRecord } from "../agent/model.js";

export interface StoredRoomEventRecord {
  readonly roomId: string;
  readonly sequence: number;
  readonly matrixEventId: string;
  readonly event: EventEnvelope;
  readonly retainedUntil?: string;
}

export interface AppendedRoomEvent {
  readonly created: boolean;
  readonly record: StoredRoomEventRecord;
  readonly candidateBindings: readonly AgentRoomBindingRecord[];
}

export function toRoomEventProjection(
  record: StoredRoomEventRecord,
  position: string
): RoomEventProjection {
  return {
    roomId: record.roomId,
    position,
    event: record.event,
    ...(record.retainedUntil === undefined
      ? {}
      : { retainedUntil: record.retainedUntil })
  };
}
