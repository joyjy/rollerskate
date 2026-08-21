import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { integrationBindingSchema } from "@rollerskate/protocol";

import type { IntegrationBindingRecord } from
  "../../../modules/connector/model.js";
import type { ConnectorRepository } from
  "../../../modules/connector/repository.js";

interface IntegrationBindingRow extends RowDataPacket {
  binding_id: string;
  owner_human_id: string;
  connector_id: string;
  connector_version: string;
  placement: "server" | "runtime";
  endpoint_ref: string;
  profile_ids: unknown;
  external_scope_ref: string;
  credential_ref: string;
  cursor_value: string | null;
  status: "active" | "suspended" | "revoked";
  revision: number;
  created_at: Date;
  updated_at: Date;
}

export class MysqlConnectorRepository implements ConnectorRepository {
  readonly #pool: Pool;

  public constructor(pool: Pool) {
    this.#pool = pool;
  }

  public async createIntegrationBinding(binding: IntegrationBindingRecord): Promise<void> {
    await this.#pool.execute(`
      INSERT INTO integration_bindings (
        binding_id, owner_human_id, connector_id, connector_version, placement,
        endpoint_ref, profile_ids, external_scope_ref, credential_ref, cursor_value,
        status, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      binding.bindingId, binding.ownerHumanId, binding.connectorId,
      binding.connectorVersion, binding.placement, binding.endpointRef,
      JSON.stringify(binding.profileIds), binding.externalScopeRef, binding.credentialRef,
      binding.cursor ?? null, binding.status, binding.revision,
      sqlDate(binding.createdAt), sqlDate(binding.updatedAt)
    ]);
  }

  public async getIntegrationBinding(
    bindingId: string
  ): Promise<IntegrationBindingRecord | undefined> {
    const [rows] = await this.#pool.execute<IntegrationBindingRow[]>(`
      SELECT * FROM integration_bindings WHERE binding_id = ?
    `, [bindingId]);
    return rows[0] === undefined ? undefined : integrationBinding(rows[0]);
  }

  public async updateIntegrationBinding(
    binding: IntegrationBindingRecord,
    expectedRevision: number
  ): Promise<IntegrationBindingRecord | undefined> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      UPDATE integration_bindings
      SET cursor_value = ?, status = ?, revision = revision + 1, updated_at = ?
      WHERE binding_id = ? AND revision = ?
    `, [
      binding.cursor ?? null, binding.status, sqlDate(binding.updatedAt),
      binding.bindingId, expectedRevision
    ]);
    return result.affectedRows === 1
      ? this.getIntegrationBinding(binding.bindingId)
      : undefined;
  }
}

function integrationBinding(row: IntegrationBindingRow): IntegrationBindingRecord {
  return integrationBindingSchema.parse({
    schemaVersion: "IntegrationBinding@1",
    bindingId: row.binding_id,
    ownerHumanId: row.owner_human_id,
    connectorId: row.connector_id,
    connectorVersion: row.connector_version,
    placement: row.placement,
    endpointRef: row.endpoint_ref,
    profileIds: json(row.profile_ids),
    externalScopeRef: row.external_scope_ref,
    credentialRef: row.credential_ref,
    ...(row.cursor_value === null ? {} : { cursor: row.cursor_value }),
    status: row.status,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function sqlDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid Connector timestamp");
  return date;
}
