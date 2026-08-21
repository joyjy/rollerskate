import type {
  AppendedRoomEvent,
  MatrixPrincipalRecord,
  RoomMembershipRecord,
  RoomRecord,
  StoredRoomEventRecord
} from "../../../../application/model.js";
import type { RoomRepository } from "../../../../application/room/repository.js";
import type { EventRepository } from "../../../../modules/event/repository.js";
import {
  membershipKey,
  MemoryRepositoryState,
  principalKey
} from "./state.js";

type MemoryRoomEventPort = RoomRepository & Omit<EventRepository, "getAgentRoomBinding">;

export class MemoryRoomEventRepository implements MemoryRoomEventPort {
  readonly #state: MemoryRepositoryState;

  public constructor(state: MemoryRepositoryState) {
    this.#state = state;
  }

  public async createRoom(
    room: RoomRecord,
    creator: RoomMembershipRecord
  ): Promise<void> {
    if (this.#state.rooms.has(room.id) || this.#state.roomMatrixIds.has(room.matrixRoomId)) {
      throw new Error(`Room already exists: ${room.id}`);
    }
    this.#state.rooms.set(room.id, room);
    this.#state.roomMatrixIds.set(room.matrixRoomId, room.id);
    this.#state.roomMemberships.set(membershipKey(room.id, creator.humanId), creator);
  }

  public async getRoom(roomId: string): Promise<RoomRecord | undefined> {
    return this.#state.rooms.get(roomId);
  }

  public async getRoomByMatrixId(matrixRoomId: string): Promise<RoomRecord | undefined> {
    const id = this.#state.roomMatrixIds.get(matrixRoomId);
    return id === undefined ? undefined : this.#state.rooms.get(id);
  }

  public async listRoomsForHuman(humanId: string): Promise<readonly {
    readonly room: RoomRecord;
    readonly membership?: RoomMembershipRecord;
  }[]> {
    return [...this.#state.rooms.values()]
      .filter((room) => {
        const membership = this.#state.roomMemberships.get(membershipKey(room.id, humanId));
        return room.visibility === "public" ||
          (membership !== undefined && membership.status !== "left");
      })
      .map((room) => {
        const membership = this.#state.roomMemberships.get(membershipKey(room.id, humanId));
        return { room, ...(membership === undefined ? {} : { membership }) };
      })
      .sort((left, right) => left.room.name.localeCompare(right.room.name));
  }

  public async getRoomMembership(
    roomId: string,
    humanId: string
  ): Promise<RoomMembershipRecord | undefined> {
    return this.#state.roomMemberships.get(membershipKey(roomId, humanId));
  }

  public async putRoomMembership(membership: RoomMembershipRecord): Promise<void> {
    this.#state.roomMemberships.set(membershipKey(membership.roomId, membership.humanId), membership);
  }

  public async appendRoomEvent(input: {
    readonly roomId: string;
    readonly matrixEventId: string;
    readonly event: StoredRoomEventRecord["event"];
    readonly retainedUntil?: string;
  }): Promise<AppendedRoomEvent> {
    const existing = this.#state.matrixEvents.get(input.matrixEventId);
    if (existing !== undefined) {
      return { created: false, record: existing, candidateBindings: [] };
    }
    const room = this.#state.rooms.get(input.roomId);
    if (room === undefined) {
      throw new Error(`Room is missing: ${input.roomId}`);
    }
    const record: StoredRoomEventRecord = {
      roomId: room.id,
      sequence: room.headSequence + 1,
      matrixEventId: input.matrixEventId,
      event: input.event,
      ...(input.retainedUntil === undefined ? {} : { retainedUntil: input.retainedUntil })
    };
    this.#state.rooms.set(room.id, { ...room, headSequence: record.sequence });
    const events = this.#state.roomEvents.get(room.id) ?? [];
    events.push(record);
    this.#state.roomEvents.set(room.id, events);
    this.#state.matrixEvents.set(input.matrixEventId, record);
    return {
      created: true,
      record,
      candidateBindings: [...this.#state.roomBindings.values()].filter(
        (binding) => binding.roomId === room.id && binding.status === "active"
      )
    };
  }

  public async listRoomEvents(
    roomId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number
  ): Promise<readonly StoredRoomEventRecord[]> {
    return (this.#state.roomEvents.get(roomId) ?? [])
      .filter((event) => event.sequence > afterSequence && event.sequence <= throughSequence)
      .slice(0, limit);
  }

  public async getMatrixPrincipalByMxid(
    mxid: string
  ): Promise<MatrixPrincipalRecord | undefined> {
    const key = this.#state.matrixMxids.get(mxid);
    return key === undefined ? undefined : this.#state.matrixPrincipals.get(key);
  }

  public async getMatrixPrincipal(
    principalKind: MatrixPrincipalRecord["principalKind"],
    principalId: string
  ): Promise<MatrixPrincipalRecord | undefined> {
    return this.#state.matrixPrincipals.get(principalKey(principalKind, principalId));
  }

  public async putMatrixPrincipal(record: MatrixPrincipalRecord): Promise<void> {
    const key = principalKey(record.principalKind, record.principalId);
    const mxidOwner = this.#state.matrixMxids.get(record.mxid);
    if (mxidOwner !== undefined && mxidOwner !== key) {
      throw new Error(`Matrix principal MXID is already assigned: ${record.mxid}`);
    }
    this.#state.matrixPrincipals.set(key, record);
    this.#state.matrixMxids.set(record.mxid, key);
  }

  public async isMatrixTransactionComplete(transactionId: string): Promise<boolean> {
    return this.#state.matrixTransactions.has(transactionId);
  }

  public async completeMatrixTransaction(
    transactionId: string,
    _now: string
  ): Promise<boolean> {
    if (this.#state.matrixTransactions.has(transactionId)) {
      return false;
    }
    this.#state.matrixTransactions.add(transactionId);
    return true;
  }
}
