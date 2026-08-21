import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type {
  AppendedRoomEvent,
  MatrixPrincipalRecord,
  RoomMembershipRecord,
  RoomRecord,
  StoredRoomEventRecord
} from "../../../../application/model.js";
import type { RoomRepository } from "../../../../application/room/repository.js";
import type { EventRepository } from "../../../../modules/event/repository.js";
import type {
  AgentRoomBindingRow,
  MatrixPrincipalRow,
  RoomListRow,
  RoomMembershipRow,
  RoomRow,
  StoredRoomEventRow
} from "./support.js";
import {
  AGENT_ROOM_BINDING_SELECT,
  agentRoomBindingRecord,
  MATRIX_PRINCIPAL_SELECT,
  matrixPrincipalRecord,
  membershipValues,
  ROOM_MEMBERSHIP_SELECT,
  ROOM_SELECT,
  roomMembershipRecord,
  roomRecord,
  sqlDate,
  STORED_ROOM_EVENT_SELECT,
  storedRoomEventRecord,
  withTransaction
} from "./support.js";

type MysqlRoomEventPort = RoomRepository & Omit<EventRepository, "getAgentRoomBinding">;

export class MysqlRoomEventRepository implements MysqlRoomEventPort {
  readonly #pool: Pool;

  public constructor(pool: Pool) {
    this.#pool = pool;
  }

  public async createRoom(
    room: RoomRecord,
    creator: RoomMembershipRecord
  ): Promise<void> {
    await withTransaction(this.#pool, async (connection) => {
      await connection.execute(`
        INSERT INTO rooms (
          id, name, matrix_room_id, visibility, created_by_human_id,
          head_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        room.id, room.name, room.matrixRoomId, room.visibility,
        room.createdByHumanId, room.headSequence, sqlDate(room.createdAt)
      ]);
      await connection.execute(`
        INSERT INTO room_human_memberships (
          room_id, human_id, role, can_invite, status,
          invited_by_human_id, created_at, left_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, membershipValues(creator));
    });
  }

  public async getRoom(roomId: string): Promise<RoomRecord | undefined> {
    const [rows] = await this.#pool.execute<RoomRow[]>(`
      ${ROOM_SELECT} WHERE id = ?
    `, [roomId]);
    return rows[0] === undefined ? undefined : roomRecord(rows[0]);
  }

  public async getRoomByMatrixId(
    matrixRoomId: string
  ): Promise<RoomRecord | undefined> {
    const [rows] = await this.#pool.execute<RoomRow[]>(`
      ${ROOM_SELECT} WHERE matrix_room_id = ?
    `, [matrixRoomId]);
    return rows[0] === undefined ? undefined : roomRecord(rows[0]);
  }

  public async listRoomsForHuman(humanId: string): Promise<readonly {
    readonly room: RoomRecord;
    readonly membership?: RoomMembershipRecord;
  }[]> {
    const [rows] = await this.#pool.execute<RoomListRow[]>(`
      SELECT
        r.id, r.name, r.matrix_room_id, r.visibility,
        r.created_by_human_id, r.head_sequence, r.created_at,
        m.human_id AS membership_human_id,
        m.role AS membership_role,
        m.can_invite AS membership_can_invite,
        m.status AS membership_status,
        m.invited_by_human_id AS membership_invited_by_human_id,
        m.created_at AS membership_created_at,
        m.left_at AS membership_left_at
      FROM rooms r
      LEFT JOIN room_human_memberships m
        ON m.room_id = r.id AND m.human_id = ?
      WHERE r.visibility = 'public' OR m.status IN ('invited', 'active')
      ORDER BY r.name ASC, r.id ASC
    `, [humanId]);
    return rows.map((row) => ({
      room: roomRecord(row),
      ...(row.membership_human_id === null
        ? {}
        : { membership: roomMembershipRecord(row) })
    }));
  }

  public async getRoomMembership(
    roomId: string,
    humanId: string
  ): Promise<RoomMembershipRecord | undefined> {
    const [rows] = await this.#pool.execute<RoomMembershipRow[]>(`
      ${ROOM_MEMBERSHIP_SELECT} WHERE room_id = ? AND human_id = ?
    `, [roomId, humanId]);
    return rows[0] === undefined ? undefined : roomMembershipRecord(rows[0]);
  }

  public async putRoomMembership(membership: RoomMembershipRecord): Promise<void> {
    await this.#pool.execute(`
      INSERT INTO room_human_memberships (
        room_id, human_id, role, can_invite, status,
        invited_by_human_id, created_at, left_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        role = VALUES(role), can_invite = VALUES(can_invite),
        status = VALUES(status), invited_by_human_id = VALUES(invited_by_human_id),
        left_at = VALUES(left_at)
    `, membershipValues(membership));
  }

  public async appendRoomEvent(input: {
    readonly roomId: string;
    readonly matrixEventId: string;
    readonly event: StoredRoomEventRecord["event"];
    readonly retainedUntil?: string;
  }): Promise<AppendedRoomEvent> {
    return withTransaction(this.#pool, async (connection) => {
      const [roomRows] = await connection.execute<RoomRow[]>(`
        ${ROOM_SELECT} WHERE id = ? FOR UPDATE
      `, [input.roomId]);
      const room = roomRows[0];
      if (room === undefined) {
        throw new Error(`Room is missing: ${input.roomId}`);
      }
      const [existingRows] = await connection.execute<StoredRoomEventRow[]>(`
        ${STORED_ROOM_EVENT_SELECT} WHERE matrix_event_id = ?
      `, [input.matrixEventId]);
      const existing = existingRows[0];
      if (existing !== undefined) {
        return {
          created: false,
          record: storedRoomEventRecord(existing),
          candidateBindings: []
        };
      }
      const sequence = Number(room.head_sequence) + 1;
      const position = String(sequence);
      await connection.execute(`
        UPDATE rooms SET head_sequence = ?, room_head = ? WHERE id = ?
      `, [sequence, position, input.roomId]);
      await connection.execute(`
        INSERT INTO room_event_projections (
          event_id, room_id, room_position, room_sequence, matrix_event_id,
          event_type, occurred_at, source_kind, source_id, payload,
          adapter_metadata, event_json, retained_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        input.event.eventId,
        input.roomId,
        position,
        sequence,
        input.matrixEventId,
        input.event.type,
        sqlDate(input.event.occurredAt),
        input.event.source.kind,
        input.event.source.id,
        JSON.stringify(input.event.payload),
        input.event.adapter === undefined
          ? null
          : JSON.stringify(input.event.adapter.metadata),
        JSON.stringify(input.event),
        input.retainedUntil === undefined ? null : sqlDate(input.retainedUntil)
      ]);
      const [bindingRows] = await connection.execute<AgentRoomBindingRow[]>(`
        ${AGENT_ROOM_BINDING_SELECT}
        WHERE room_id = ? AND status = 'active'
        ORDER BY agent_id ASC
      `, [input.roomId]);
      return {
        created: true,
        record: {
          roomId: input.roomId,
          sequence,
          matrixEventId: input.matrixEventId,
          event: input.event,
          ...(input.retainedUntil === undefined
            ? {}
            : { retainedUntil: input.retainedUntil })
        },
        candidateBindings: bindingRows.map(agentRoomBindingRecord)
      };
    });
  }

  public async listRoomEvents(
    roomId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number
  ): Promise<readonly StoredRoomEventRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Room event limit must be from 1 to 100");
    }
    const [rows] = await this.#pool.execute<StoredRoomEventRow[]>(`
      ${STORED_ROOM_EVENT_SELECT}
      WHERE room_id = ? AND room_sequence > ? AND room_sequence <= ?
      ORDER BY room_sequence ASC
      LIMIT ${limit}
    `, [roomId, afterSequence, throughSequence]);
    return rows.map(storedRoomEventRecord);
  }

  public async getMatrixPrincipalByMxid(
    mxid: string
  ): Promise<MatrixPrincipalRecord | undefined> {
    const [rows] = await this.#pool.execute<MatrixPrincipalRow[]>(`
      ${MATRIX_PRINCIPAL_SELECT} WHERE mxid = ?
    `, [mxid]);
    return rows[0] === undefined ? undefined : matrixPrincipalRecord(rows[0]);
  }

  public async getMatrixPrincipal(
    principalKind: MatrixPrincipalRecord["principalKind"],
    principalId: string
  ): Promise<MatrixPrincipalRecord | undefined> {
    const [rows] = await this.#pool.execute<MatrixPrincipalRow[]>(`
      ${MATRIX_PRINCIPAL_SELECT}
      WHERE principal_kind = ? AND principal_id = ?
    `, [principalKind, principalId]);
    return rows[0] === undefined ? undefined : matrixPrincipalRecord(rows[0]);
  }

  public async putMatrixPrincipal(record: MatrixPrincipalRecord): Promise<void> {
    await this.#pool.execute(`
      INSERT INTO matrix_principals (
        principal_kind, principal_id, mxid, created_at
      ) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE mxid = VALUES(mxid)
    `, [record.principalKind, record.principalId, record.mxid, sqlDate(record.createdAt)]);
  }

  public async isMatrixTransactionComplete(transactionId: string): Promise<boolean> {
    const [rows] = await this.#pool.execute<RowDataPacket[]>(`
      SELECT 1 AS completed FROM matrix_transactions WHERE transaction_id = ?
    `, [transactionId]);
    return rows.length === 1;
  }

  public async completeMatrixTransaction(
    transactionId: string,
    now: string
  ): Promise<boolean> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      INSERT IGNORE INTO matrix_transactions (transaction_id, completed_at)
      VALUES (?, ?)
    `, [transactionId, sqlDate(now)]);
    return result.affectedRows === 1;
  }

}
