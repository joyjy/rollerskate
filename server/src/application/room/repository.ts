import type {
  MatrixPrincipalRecord,
  RoomMembershipRecord,
  RoomRecord
} from "./model.js";

export interface RoomRepository {
  createRoom(room: RoomRecord, creator: RoomMembershipRecord): Promise<void>;
  getRoom(roomId: string): Promise<RoomRecord | undefined>;
  getRoomByMatrixId(matrixRoomId: string): Promise<RoomRecord | undefined>;
  listRoomsForHuman(humanId: string): Promise<readonly {
    readonly room: RoomRecord;
    readonly membership?: RoomMembershipRecord;
  }[]>;
  getRoomMembership(
    roomId: string,
    humanId: string
  ): Promise<RoomMembershipRecord | undefined>;
  putRoomMembership(membership: RoomMembershipRecord): Promise<void>;
  getMatrixPrincipalByMxid(mxid: string): Promise<MatrixPrincipalRecord | undefined>;
  getMatrixPrincipal(
    principalKind: MatrixPrincipalRecord["principalKind"],
    principalId: string
  ): Promise<MatrixPrincipalRecord | undefined>;
  putMatrixPrincipal(record: MatrixPrincipalRecord): Promise<void>;
}
