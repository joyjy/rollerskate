import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { agentWorkRequestSchema } from "@rollerskate/protocol";

import type { AgentWorkRequestRecord } from
  "../../../modules/work-request/model.js";
import type { WorkRequestRepository } from
  "../../../modules/work-request/repository.js";

interface WorkRequestRow extends RowDataPacket {
  work_request_id: string;
  requester_kind: "human" | "agent";
  requester_id: string;
  request_id: string;
  target_agent_id: string;
  target_route_id: string | null;
  status: string;
  revision: number;
  request_digest: string;
  value_json: unknown;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export class MysqlWorkRequestRepository implements WorkRequestRepository {
  readonly #pool: Pool;

  public constructor(pool: Pool) {
    this.#pool = pool;
  }

  public async createWorkRequest(
    record: AgentWorkRequestRecord,
    maximumPendingForRequester: number
  ): Promise<"created" | "existing" | "conflict" | "pending-limit"> {
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existingRows] = await connection.execute<WorkRequestRow[]>(`
        SELECT * FROM agent_work_requests
        WHERE requester_kind = ? AND requester_id = ? AND request_id = ?
        FOR UPDATE
      `, [
        record.value.requesterRef.kind,
        record.value.requesterRef.id,
        record.value.requestId
      ]);
      if (existingRows[0] !== undefined) {
        await connection.commit();
        return existingRows[0].request_digest === record.requestDigest ? "existing" : "conflict";
      }
      if (isPending(record)) {
        const [pending] = await connection.execute<WorkRequestRow[]>(`
          SELECT work_request_id FROM agent_work_requests
          WHERE requester_kind = ? AND requester_id = ?
            AND status IN ('received', 'awaiting-owner')
            AND expires_at > ?
          FOR UPDATE
        `, [
          record.value.requesterRef.kind,
          record.value.requesterRef.id,
          sqlDate(record.value.createdAt)
        ]);
        if (pending.length >= maximumPendingForRequester) {
          await connection.commit();
          return "pending-limit";
        }
      }
      await connection.execute(`
        INSERT INTO agent_work_requests (
          work_request_id, requester_kind, requester_id, request_id,
          target_agent_id, target_route_id, status, revision, request_digest,
          value_json, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, values(record));
      await connection.commit();
      return "created";
    } catch (error) {
      await connection.rollback();
      if (!isDuplicateEntry(error)) throw error;
      const existing = await this.getWorkRequestByIdempotency(
        record.value.requesterRef.kind,
        record.value.requesterRef.id,
        record.value.requestId
      );
      return existing?.requestDigest === record.requestDigest ? "existing" : "conflict";
    } finally {
      connection.release();
    }
  }

  public async getWorkRequest(
    workRequestId: string
  ): Promise<AgentWorkRequestRecord | undefined> {
    const [rows] = await this.#pool.execute<WorkRequestRow[]>(`
      SELECT * FROM agent_work_requests WHERE work_request_id = ?
    `, [workRequestId]);
    return rows[0] === undefined ? undefined : map(rows[0]);
  }

  public async getWorkRequestByIdempotency(
    requesterKind: "human" | "agent",
    requesterId: string,
    requestId: string
  ): Promise<AgentWorkRequestRecord | undefined> {
    const [rows] = await this.#pool.execute<WorkRequestRow[]>(`
      SELECT * FROM agent_work_requests
      WHERE requester_kind = ? AND requester_id = ? AND request_id = ?
    `, [requesterKind, requesterId, requestId]);
    return rows[0] === undefined ? undefined : map(rows[0]);
  }

  public async updateWorkRequest(
    record: AgentWorkRequestRecord,
    expectedRevision: number
  ): Promise<AgentWorkRequestRecord | undefined> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      UPDATE agent_work_requests
      SET status = ?, revision = ?, value_json = ?, updated_at = ?
      WHERE work_request_id = ? AND revision = ?
    `, [
      record.value.status,
      record.value.revision,
      JSON.stringify(record.value),
      sqlDate(record.value.updatedAt),
      record.value.workRequestId,
      expectedRevision
    ]);
    return result.affectedRows === 1
      ? this.getWorkRequest(record.value.workRequestId)
      : undefined;
  }

  public async listRoutedWorkRequests(
    targetAgentId: string,
    routeId: string,
    limit: number
  ): Promise<readonly AgentWorkRequestRecord[]> {
    const [rows] = await this.#pool.query<WorkRequestRow[]>(`
      SELECT * FROM agent_work_requests
      WHERE target_agent_id = ? AND target_route_id = ?
        AND status IN ('received', 'awaiting-owner')
      ORDER BY created_at, work_request_id LIMIT ?
    `, [targetAgentId, routeId, limit]);
    return rows.map(map);
  }

  public async listAcceptedWorkRequestsWithoutRun(
    targetAgentId: string,
    limit: number
  ): Promise<readonly AgentWorkRequestRecord[]> {
    const [rows] = await this.#pool.query<WorkRequestRow[]>(`
      SELECT * FROM agent_work_requests
      WHERE target_agent_id = ? AND status = 'accepted'
        AND JSON_EXTRACT(value_json, '$.runReceipt') IS NULL
      ORDER BY updated_at, work_request_id LIMIT ?
    `, [targetAgentId, limit]);
    return rows.map(map);
  }
}

function values(record: AgentWorkRequestRecord): unknown[] {
  return [
    record.value.workRequestId,
    record.value.requesterRef.kind,
    record.value.requesterRef.id,
    record.value.requestId,
    record.value.targetAgentRef.id,
    record.targetRouteId ?? null,
    record.value.status,
    record.value.revision,
    record.requestDigest,
    JSON.stringify(record.value),
    sqlDate(record.value.expiresAt),
    sqlDate(record.value.createdAt),
    sqlDate(record.value.updatedAt)
  ];
}

function map(row: WorkRequestRow): AgentWorkRequestRecord {
  const value = agentWorkRequestSchema.parse(json(row.value_json));
  if (value.workRequestId !== row.work_request_id ||
    value.requesterRef.kind !== row.requester_kind ||
    value.requesterRef.id !== row.requester_id ||
    value.requestId !== row.request_id ||
    value.targetAgentRef.id !== row.target_agent_id ||
    value.status !== row.status || value.revision !== Number(row.revision) ||
    value.expiresAt !== row.expires_at.toISOString()) {
    throw new Error(`Agent work request row mismatch: ${row.work_request_id}`);
  }
  return {
    value,
    requestDigest: row.request_digest,
    ...(row.target_route_id === null ? {} : { targetRouteId: row.target_route_id })
  };
}

function isPending(record: AgentWorkRequestRecord): boolean {
  return record.value.status === "received" || record.value.status === "awaiting-owner";
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function sqlDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid SQL timestamp: ${value}`);
  return date;
}

function isDuplicateEntry(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ER_DUP_ENTRY";
}
