import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { DeviceSummary } from "../../protocol.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";

export interface LocalDeviceMetadata {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly serverUrl: string;
  readonly credentialId?: string;
  readonly status: "pairing" | "active" | "revoked";
  readonly pairedAt?: string;
  readonly lastVerifiedAt?: string;
  readonly humanId?: string;
  readonly humanDisplayName?: string;
  readonly humanIsAdmin?: boolean;
}

interface DeviceMetadataRow {
  device_id: string;
  device_name: string;
  server_url: string;
  credential_id: string | null;
  status: LocalDeviceMetadata["status"];
  paired_at: string | null;
  last_verified_at: string | null;
  human_id: string | null;
  human_display_name: string | null;
  human_is_admin: number | null;
}

export class LocalDeviceStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = openRuntimeDatabase(databasePath);
    this.#migrate();
  }

  public close(): void {
    this.#database.close();
  }

  public current(): LocalDeviceMetadata | undefined {
    const row = this.#database.prepare(`
      SELECT device_id, device_name, server_url, credential_id, status, paired_at,
             last_verified_at, human_id, human_display_name, human_is_admin
      FROM local_device_registration WHERE singleton = 1
    `).get() as DeviceMetadataRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  public beginPairing(serverUrl: string, deviceName: string): LocalDeviceMetadata {
    const existing = this.current();
    if (existing?.status === "active") {
      throw new Error("this Local Runtime is already paired; run device logout first");
    }
    const metadata: LocalDeviceMetadata = {
      deviceId: existing?.status === "pairing" && existing.serverUrl === serverUrl
        ? existing.deviceId
        : randomUUID(),
      deviceName,
      serverUrl,
      status: "pairing"
    };
    this.#database.prepare(`
      INSERT INTO local_device_registration (
        singleton, device_id, device_name, server_url, status
      ) VALUES (1, ?, ?, ?, 'pairing')
      ON CONFLICT(singleton) DO UPDATE SET
        device_id = excluded.device_id,
        device_name = excluded.device_name,
        server_url = excluded.server_url,
        credential_id = NULL,
        status = 'pairing',
        paired_at = NULL,
        last_verified_at = NULL,
        human_id = NULL,
        human_display_name = NULL,
        human_is_admin = NULL
    `).run(metadata.deviceId, metadata.deviceName, metadata.serverUrl);
    return metadata;
  }

  public activate(
    credentialId: string,
    summary: DeviceSummary,
    timestamp: string
  ): LocalDeviceMetadata {
    const result = this.#database.prepare(`
      UPDATE local_device_registration
      SET device_name = ?, credential_id = ?, status = 'active', paired_at = ?,
          last_verified_at = ?, human_id = ?, human_display_name = ?, human_is_admin = ?
      WHERE singleton = 1 AND device_id = ? AND status = 'pairing'
    `).run(
      summary.name,
      credentialId,
      timestamp,
      timestamp,
      summary.human.id,
      summary.human.displayName,
      summary.human.isAdmin ? 1 : 0,
      summary.id
    );
    if (result.changes !== 1) {
      throw new Error("local pairing metadata changed before activation");
    }
    const current = this.current();
    if (current === undefined) {
      throw new Error("activated local device metadata is missing");
    }
    return current;
  }

  public verify(summary: DeviceSummary, timestamp: string): LocalDeviceMetadata {
    const result = this.#database.prepare(`
      UPDATE local_device_registration
      SET device_name = ?, status = ?, last_verified_at = ?, human_id = ?,
          human_display_name = ?, human_is_admin = ?
      WHERE singleton = 1 AND device_id = ?
    `).run(
      summary.name,
      summary.status,
      timestamp,
      summary.human.id,
      summary.human.displayName,
      summary.human.isAdmin ? 1 : 0,
      summary.id
    );
    if (result.changes !== 1) {
      throw new Error("local device metadata does not match Server response");
    }
    const current = this.current();
    if (current === undefined) {
      throw new Error("verified local device metadata is missing");
    }
    return current;
  }

  public revoke(timestamp: string): void {
    this.#database.prepare(`
      UPDATE local_device_registration
      SET status = 'revoked', last_verified_at = ?
      WHERE singleton = 1
    `).run(timestamp);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_device_registration (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        credential_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pairing', 'active', 'revoked')),
        paired_at TEXT,
        last_verified_at TEXT,
        human_id TEXT,
        human_display_name TEXT,
        human_is_admin INTEGER
      );
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '13')
      ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), 13);
    `);
  }
}

function fromRow(row: DeviceMetadataRow): LocalDeviceMetadata {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    serverUrl: row.server_url,
    status: row.status,
    ...(row.credential_id === null ? {} : { credentialId: row.credential_id }),
    ...(row.paired_at === null ? {} : { pairedAt: row.paired_at }),
    ...(row.last_verified_at === null ? {} : { lastVerifiedAt: row.last_verified_at }),
    ...(row.human_id === null ? {} : { humanId: row.human_id }),
    ...(row.human_display_name === null
      ? {}
      : { humanDisplayName: row.human_display_name }),
    ...(row.human_is_admin === null
      ? {}
      : { humanIsAdmin: Boolean(row.human_is_admin) })
  };
}
