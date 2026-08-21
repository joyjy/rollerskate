import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import type {
  AgentAggregate,
  AgentCredentialRecord,
  AgentRecord,
  EnrollmentGrantRecord,
  HumanRecord,
  PlacementRecord
} from "../../../../application/model.js";
import { parseMetadata } from "./human-support.js";

export interface AgentRow extends RowDataPacket {
  id: string;
  name: string;
  owner_human_id: string;
  operator_human_id: string;
  status: AgentRecord["status"];
  created_at: Date;
  suspended_at: Date | null;
}

export interface PlacementRow extends RowDataPacket {
  id: string;
  agent_id: string;
  device_id: string;
  state: PlacementRecord["state"];
  generation: number;
  created_at: Date;
  activated_at: Date | null;
  superseded_at: Date | null;
}

export interface EnrollmentRow extends RowDataPacket {
  id: string;
  agent_id: string;
  device_id: string;
  placement_id: string;
  credential_id: string | null;
  verifier_hash: string;
  status: EnrollmentGrantRecord["status"];
  expires_at: Date;
  redeemed_at: Date | null;
  created_at: Date;
}

export interface AgentAggregateRow extends RowDataPacket {
  agent_id: string;
  agent_name: string;
  owner_human_id: string;
  operator_human_id: string;
  agent_status: AgentRecord["status"];
  agent_created_at: Date;
  agent_suspended_at: Date | null;
  placement_id: string;
  placement_device_id: string;
  placement_state: PlacementRecord["state"];
  placement_generation: number;
  placement_created_at: Date;
  placement_activated_at: Date | null;
  placement_superseded_at: Date | null;
  credential_status: AgentCredentialRecord["status"] | null;
  owner_issuer: string;
  owner_subject: string;
  owner_display_name: string;
  owner_status: HumanRecord["status"];
  owner_is_admin: number | boolean;
  owner_metadata: string | null;
  owner_created_at: Date;
  operator_issuer: string;
  operator_subject: string;
  operator_display_name: string;
  operator_status: HumanRecord["status"];
  operator_is_admin: number | boolean;
  operator_metadata: string | null;
  operator_created_at: Date;
}

export interface AgentAuthenticationRow extends AgentAggregateRow {
  credential_id: string;
  credential_agent_id: string;
  credential_placement_id: string;
  secret_hash: string;
  credential_created_at: Date;
  credential_expires_at: Date | null;
  credential_revoked_at: Date | null;
}

export const AGENT_AGGREGATE_SELECT = `
  SELECT
    a.id AS agent_id,
    a.name AS agent_name,
    a.owner_human_id,
    a.operator_human_id,
    a.status AS agent_status,
    a.created_at AS agent_created_at,
    a.suspended_at AS agent_suspended_at,
    p.id AS placement_id,
    p.device_id AS placement_device_id,
    p.state AS placement_state,
    p.generation AS placement_generation,
    p.created_at AS placement_created_at,
    p.activated_at AS placement_activated_at,
    p.superseded_at AS placement_superseded_at,
    c.status AS credential_status,
    owner.oauth_issuer AS owner_issuer,
    owner.oauth_subject AS owner_subject,
    owner.display_name AS owner_display_name,
    owner.status AS owner_status,
    owner.is_admin AS owner_is_admin,
    owner.identity_metadata AS owner_metadata,
    owner.created_at AS owner_created_at,
    operator.oauth_issuer AS operator_issuer,
    operator.oauth_subject AS operator_subject,
    operator.display_name AS operator_display_name,
    operator.status AS operator_status,
    operator.is_admin AS operator_is_admin,
    operator.identity_metadata AS operator_metadata,
    operator.created_at AS operator_created_at
  FROM agents a
  JOIN placements p ON p.agent_id = a.id
  JOIN humans owner ON owner.id = a.owner_human_id
  JOIN humans operator ON operator.id = a.operator_human_id
  LEFT JOIN credential_metadata c ON c.id = (
    SELECT latest.id
    FROM credential_metadata latest
    WHERE latest.principal_kind = 'agent'
      AND latest.principal_id = a.id
      AND latest.placement_id = p.id
    ORDER BY latest.created_at DESC, latest.id DESC
    LIMIT 1
  )
`;

export const AGENT_AUTHENTICATION_SELECT = `
  SELECT
    a.id AS agent_id,
    a.name AS agent_name,
    a.owner_human_id,
    a.operator_human_id,
    a.status AS agent_status,
    a.created_at AS agent_created_at,
    a.suspended_at AS agent_suspended_at,
    p.id AS placement_id,
    p.device_id AS placement_device_id,
    p.state AS placement_state,
    p.generation AS placement_generation,
    p.created_at AS placement_created_at,
    p.activated_at AS placement_activated_at,
    p.superseded_at AS placement_superseded_at,
    c.status AS credential_status,
    owner.oauth_issuer AS owner_issuer,
    owner.oauth_subject AS owner_subject,
    owner.display_name AS owner_display_name,
    owner.status AS owner_status,
    owner.is_admin AS owner_is_admin,
    owner.identity_metadata AS owner_metadata,
    owner.created_at AS owner_created_at,
    operator.oauth_issuer AS operator_issuer,
    operator.oauth_subject AS operator_subject,
    operator.display_name AS operator_display_name,
    operator.status AS operator_status,
    operator.is_admin AS operator_is_admin,
    operator.identity_metadata AS operator_metadata,
    operator.created_at AS operator_created_at,
    c.id AS credential_id,
    c.principal_id AS credential_agent_id,
    c.placement_id AS credential_placement_id,
    c.secret_hash,
    c.created_at AS credential_created_at,
    c.expires_at AS credential_expires_at,
    c.revoked_at AS credential_revoked_at
  FROM credential_metadata c
  JOIN agents a ON a.id = c.principal_id
  JOIN placements p ON p.id = c.placement_id AND p.agent_id = a.id
  JOIN humans owner ON owner.id = a.owner_human_id
  JOIN humans operator ON operator.id = a.operator_human_id
`;

export async function loadAgentAggregate(
  connection: PoolConnection,
  agentId: string,
  placementId: string
): Promise<AgentAggregate> {
  const [rows] = await connection.execute<AgentAggregateRow[]>(`
    ${AGENT_AGGREGATE_SELECT}
    WHERE a.id = ? AND p.id = ?
    LIMIT 1
  `, [agentId, placementId]);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Agent aggregate is missing: ${agentId}/${placementId}`);
  }
  return agentAggregate(row);
}

export function placementRecord(row: PlacementRow): PlacementRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    deviceId: row.device_id,
    state: row.state,
    generation: row.generation,
    createdAt: row.created_at.toISOString(),
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at.toISOString() }),
    ...(row.superseded_at === null
      ? {}
      : { supersededAt: row.superseded_at.toISOString() })
  };
}

export function enrollmentRecord(row: EnrollmentRow): EnrollmentGrantRecord {
  if (typeof row.credential_id !== "string" || row.credential_id === "") {
    throw new Error(`Agent enrollment credential is missing: ${row.id}`);
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    deviceId: row.device_id,
    placementId: row.placement_id,
    credentialId: row.credential_id,
    verifierChallenge: row.verifier_hash,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.redeemed_at === null ? {} : { redeemedAt: row.redeemed_at.toISOString() })
  };
}

export function agentAggregate(row: AgentAggregateRow): AgentAggregate {
  return {
    agent: {
      id: row.agent_id,
      name: row.agent_name,
      ownerHumanId: row.owner_human_id,
      operatorHumanId: row.operator_human_id,
      status: row.agent_status,
      createdAt: row.agent_created_at.toISOString(),
      ...(row.agent_suspended_at === null
        ? {}
        : { suspendedAt: row.agent_suspended_at.toISOString() })
    },
    placement: {
      id: row.placement_id,
      agentId: row.agent_id,
      deviceId: row.placement_device_id,
      state: row.placement_state,
      generation: row.placement_generation,
      createdAt: row.placement_created_at.toISOString(),
      ...(row.placement_activated_at === null
        ? {}
        : { activatedAt: row.placement_activated_at.toISOString() }),
      ...(row.placement_superseded_at === null
        ? {}
        : { supersededAt: row.placement_superseded_at.toISOString() })
    },
    owner: prefixedHumanRecord(row, "owner"),
    operator: prefixedHumanRecord(row, "operator"),
    credentialStatus: row.credential_status ?? "pending"
  };
}

export function prefixedHumanRecord(
  row: AgentAggregateRow,
  prefix: "owner" | "operator"
): HumanRecord {
  return {
    id: prefix === "owner" ? row.owner_human_id : row.operator_human_id,
    issuer: prefix === "owner" ? row.owner_issuer : row.operator_issuer,
    subject: prefix === "owner" ? row.owner_subject : row.operator_subject,
    displayName: prefix === "owner" ? row.owner_display_name : row.operator_display_name,
    status: prefix === "owner" ? row.owner_status : row.operator_status,
    isAdmin: Boolean(prefix === "owner" ? row.owner_is_admin : row.operator_is_admin),
    metadata: parseMetadata(prefix === "owner" ? row.owner_metadata : row.operator_metadata),
    createdAt: (prefix === "owner" ? row.owner_created_at : row.operator_created_at)
      .toISOString()
  };
}
