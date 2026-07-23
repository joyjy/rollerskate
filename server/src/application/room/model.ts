import type {
  RoomMembershipSummary,
  RoomSummary,
  RoomVisibility
} from "@rollerskate/protocol";

export interface RoomRecord {
  readonly id: string;
  readonly name: string;
  readonly matrixRoomId: string;
  readonly visibility: RoomVisibility;
  readonly createdByHumanId: string;
  readonly headSequence: number;
  readonly createdAt: string;
}

export interface RoomMembershipRecord {
  readonly roomId: string;
  readonly humanId: string;
  readonly role: "owner" | "member";
  readonly canInvite: boolean;
  readonly status: "invited" | "active" | "left";
  readonly createdAt: string;
  readonly invitedByHumanId?: string;
  readonly leftAt?: string;
}

export interface MatrixPrincipalRecord {
  readonly principalKind: "human" | "agent";
  readonly principalId: string;
  readonly mxid: string;
  readonly createdAt: string;
}

export function toRoomMembershipSummary(
  membership: RoomMembershipRecord
): RoomMembershipSummary {
  return {
    humanId: membership.humanId,
    role: membership.role,
    canInvite: membership.canInvite,
    status: membership.status,
    createdAt: membership.createdAt
  };
}

export function toRoomSummary(
  room: RoomRecord,
  head: string,
  membership?: RoomMembershipRecord
): RoomSummary {
  return {
    id: room.id,
    name: room.name,
    matrixRoomId: room.matrixRoomId,
    visibility: room.visibility,
    head,
    createdAt: room.createdAt,
    ...(membership === undefined
      ? {}
      : { membership: toRoomMembershipSummary(membership) })
  };
}
