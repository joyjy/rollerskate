import type { RowDataPacket } from "mysql2/promise";

import type { HumanRecord } from "../../../../application/model.js";

export interface HumanRow extends RowDataPacket {
  id: string;
  oauth_issuer: string;
  oauth_subject: string;
  display_name: string;
  status: "active" | "revoked";
  is_admin: number | boolean;
  identity_metadata: string | null;
  created_at: Date;
}

export function humanRecord(row: HumanRow): HumanRecord {
  return {
    id: row.id,
    issuer: row.oauth_issuer,
    subject: row.oauth_subject,
    displayName: row.display_name,
    status: row.status,
    isAdmin: Boolean(row.is_admin),
    metadata: parseMetadata(row.identity_metadata),
    createdAt: row.created_at.toISOString()
  };
}

export function parseMetadata(value: string | null): Readonly<Record<string, string>> {
  if (value === null) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    ));
  } catch {
    return {};
  }
}
