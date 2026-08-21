import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { eventEnvelopeSchema } from "@rollerskate/protocol";

import type {
  AgentRoomBindingRecord,
  MatrixPrincipalRecord,
  RoomMembershipRecord,
  RoomRecord,
  StoredRoomEventRecord
} from "../../../../application/model.js";
import { sqlDate } from "./transaction.js";

export interface RoomRow extends RowDataPacket {
  id: string;
  name: string;
  matrix_room_id: string;
  visibility: RoomRecord["visibility"];
  created_by_human_id: string;
  head_sequence: number | string;
  created_at: Date;
}

export interface RoomMembershipRow extends RowDataPacket {
  room_id: string;
  human_id: string;
  role: RoomMembershipRecord["role"];
  can_invite: number | boolean;
  status: RoomMembershipRecord["status"];
  invited_by_human_id: string | null;
  created_at: Date;
  left_at: Date | null;
}

export interface RoomListRow extends RoomRow {
  membership_human_id: string | null;
  membership_role: RoomMembershipRecord["role"] | null;
  membership_can_invite: number | boolean | null;
  membership_status: RoomMembershipRecord["status"] | null;
  membership_invited_by_human_id: string | null;
  membership_created_at: Date | null;
  membership_left_at: Date | null;
}

export interface AgentRoomBindingRow extends RowDataPacket {
  id: string;
  agent_id: string;
  room_id: string;
  wake_mode: AgentRoomBindingRecord["wakeMode"];
  created_by_human_id: string;
  status: AgentRoomBindingRecord["status"];
  created_at: Date;
  updated_at: Date;
  deactivated_at: Date | null;
}

export interface StoredRoomEventRow extends RowDataPacket {
  room_id: string;
  room_sequence: number | string;
  matrix_event_id: string;
  event_json: string;
  retained_until: Date | null;
}

export interface MatrixPrincipalRow extends RowDataPacket {
  principal_kind: MatrixPrincipalRecord["principalKind"];
  principal_id: string;
  mxid: string;
  created_at: Date;
}

export const ROOM_SELECT = `
  SELECT id, name, matrix_room_id, visibility, created_by_human_id,
         head_sequence, created_at
  FROM rooms
`;

export const ROOM_MEMBERSHIP_SELECT = `
  SELECT room_id, human_id, role, can_invite, status,
         invited_by_human_id, created_at, left_at
  FROM room_human_memberships
`;

export const AGENT_ROOM_BINDING_SELECT = `
  SELECT id, agent_id, room_id, wake_mode, created_by_human_id,
         status, created_at, updated_at, deactivated_at
  FROM agent_room_bindings
`;

export const STORED_ROOM_EVENT_SELECT = `
  SELECT room_id, room_sequence, matrix_event_id, event_json, retained_until
  FROM room_event_projections
`;

export const MATRIX_PRINCIPAL_SELECT = `
  SELECT principal_kind, principal_id, mxid, created_at
  FROM matrix_principals
`;

export function roomRecord(row: RoomRow): RoomRecord {
  if (
    typeof row.name !== "string" || row.name === "" ||
    typeof row.matrix_room_id !== "string" || row.matrix_room_id === "" ||
    typeof row.created_by_human_id !== "string" || row.created_by_human_id === ""
  ) {
    throw new Error(`Room metadata is incomplete: ${row.id}`);
  }
  return {
    id: row.id,
    name: row.name,
    matrixRoomId: row.matrix_room_id,
    visibility: row.visibility,
    createdByHumanId: row.created_by_human_id,
    headSequence: Number(row.head_sequence),
    createdAt: row.created_at.toISOString()
  };
}

export function roomMembershipRecord(
  row: RoomMembershipRow | RoomListRow
): RoomMembershipRecord {
  const roomId = "room_id" in row ? row.room_id : row.id;
  const humanId = "human_id" in row ? row.human_id : row.membership_human_id;
  const role = "role" in row ? row.role : row.membership_role;
  const canInvite = "can_invite" in row ? row.can_invite : row.membership_can_invite;
  const status = "status" in row ? row.status : row.membership_status;
  const invitedBy = "invited_by_human_id" in row
    ? row.invited_by_human_id
    : row.membership_invited_by_human_id;
  const createdAt = "human_id" in row ? row.created_at : row.membership_created_at;
  const leftAt = "left_at" in row ? row.left_at : row.membership_left_at;
  if (humanId === null || role === null || canInvite === null ||
    status === null || createdAt === null) {
    throw new Error(`Room membership metadata is incomplete: ${roomId}`);
  }
  return {
    roomId,
    humanId,
    role,
    canInvite: Boolean(canInvite),
    status,
    createdAt: createdAt.toISOString(),
    ...(invitedBy === null ? {} : { invitedByHumanId: invitedBy }),
    ...(leftAt === null ? {} : { leftAt: leftAt.toISOString() })
  };
}

export function membershipValues(membership: RoomMembershipRecord): readonly unknown[] {
  return [
    membership.roomId,
    membership.humanId,
    membership.role,
    membership.canInvite,
    membership.status,
    membership.invitedByHumanId ?? null,
    sqlDate(membership.createdAt),
    membership.leftAt === undefined ? null : sqlDate(membership.leftAt)
  ];
}

export function agentRoomBindingRecord(row: AgentRoomBindingRow): AgentRoomBindingRecord {
  if (
    typeof row.created_by_human_id !== "string" || row.created_by_human_id === "" ||
    !(row.updated_at instanceof Date)
  ) {
    throw new Error(`Agent Room binding metadata is incomplete: ${row.id}`);
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    roomId: row.room_id,
    wakeMode: row.wake_mode,
    createdByHumanId: row.created_by_human_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.deactivated_at === null
      ? {}
      : { deactivatedAt: row.deactivated_at.toISOString() })
  };
}

export function bindingValues(binding: AgentRoomBindingRecord): readonly unknown[] {
  return [
    binding.id,
    binding.agentId,
    binding.roomId,
    binding.wakeMode,
    binding.createdByHumanId,
    binding.status,
    sqlDate(binding.createdAt),
    sqlDate(binding.updatedAt),
    binding.deactivatedAt === undefined ? null : sqlDate(binding.deactivatedAt)
  ];
}

export async function updateBinding(
  connection: PoolConnection,
  binding: AgentRoomBindingRecord
): Promise<void> {
  await connection.execute(`
    UPDATE agent_room_bindings
    SET id = ?, wake_mode = ?, created_by_human_id = ?, status = ?,
        created_at = ?, updated_at = ?, deactivated_at = ?
    WHERE agent_id = ? AND room_id = ?
  `, [
    binding.id,
    binding.wakeMode,
    binding.createdByHumanId,
    binding.status,
    sqlDate(binding.createdAt),
    sqlDate(binding.updatedAt),
    binding.deactivatedAt === undefined ? null : sqlDate(binding.deactivatedAt),
    binding.agentId,
    binding.roomId
  ]);
}

export function storedRoomEventRecord(row: StoredRoomEventRow): StoredRoomEventRecord {
  if (
    typeof row.matrix_event_id !== "string" || row.matrix_event_id === "" ||
    typeof row.event_json !== "string" || row.event_json === ""
  ) {
    throw new Error(`Room event metadata is incomplete: ${row.room_id}/${row.room_sequence}`);
  }
  const event = eventEnvelopeSchema.parse(JSON.parse(row.event_json) as unknown);
  return {
    roomId: row.room_id,
    sequence: Number(row.room_sequence),
    matrixEventId: row.matrix_event_id,
    event,
    ...(row.retained_until === null
      ? {}
      : { retainedUntil: row.retained_until.toISOString() })
  };
}

export function matrixPrincipalRecord(row: MatrixPrincipalRow): MatrixPrincipalRecord {
  return {
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    mxid: row.mxid,
    createdAt: row.created_at.toISOString()
  };
}
