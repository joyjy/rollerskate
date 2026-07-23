import type { DatabaseSync } from "node:sqlite";

import type { AgentSummary } from "../../protocol.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";

export const agentClients = ["codex"] as const;
export type AgentClient = (typeof agentClients)[number];

export interface LocalAgentMetadata {
  readonly agentId: string;
  readonly name: string;
  readonly status: "provisioning" | "active" | "suspended" | "revoked";
  readonly placementId: string;
  readonly deviceId: string;
  readonly generation: number;
  readonly credentialId?: string;
  readonly workspacePath: string;
  readonly client: AgentClient;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly lastVerifiedAt?: string;
}

interface LocalAgentRow {
  agent_id: string;
  name: string;
  status: LocalAgentMetadata["status"];
  placement_id: string;
  device_id: string;
  generation: number;
  credential_id: string | null;
  workspace_path: string;
  agent_client: AgentClient;
  created_at: string;
  activated_at: string | null;
  last_verified_at: string | null;
}

export class LocalAgentRegistryStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = openRuntimeDatabase(databasePath);
    this.#migrate();
  }

  public close(): void {
    this.#database.close();
  }

  public list(): readonly LocalAgentMetadata[] {
    return (this.#database.prepare(`
      SELECT agent_id, name, status, placement_id, device_id, generation,
             credential_id, workspace_path, agent_client, created_at, activated_at, last_verified_at
      FROM local_agents ORDER BY name ASC
    `).all() as unknown as LocalAgentRow[]).map(fromRow);
  }

  public get(name: string): LocalAgentMetadata | undefined {
    const row = this.#database.prepare(`
      SELECT agent_id, name, status, placement_id, device_id, generation,
             credential_id, workspace_path, agent_client, created_at, activated_at, last_verified_at
      FROM local_agents WHERE name = ?
    `).get(name) as LocalAgentRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  public provision(
    summary: AgentSummary,
    workspacePath: string,
    client: AgentClient = "codex"
  ): LocalAgentMetadata {
    this.#database.prepare(`
      INSERT INTO local_agents (
        agent_id, name, status, placement_id, device_id, generation,
        workspace_path, agent_client, created_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        agent_id = excluded.agent_id,
        status = excluded.status,
        placement_id = excluded.placement_id,
        device_id = excluded.device_id,
        generation = excluded.generation,
        workspace_path = excluded.workspace_path,
        agent_client = excluded.agent_client,
        created_at = excluded.created_at,
        activated_at = excluded.activated_at
    `).run(
      summary.id,
      summary.name,
      summary.status,
      summary.placement.id,
      summary.placement.deviceId,
      summary.placement.generation,
      workspacePath,
      client,
      summary.createdAt,
      summary.placement.activatedAt ?? null
    );
    return this.#require(summary.name);
  }

  public activate(
    summary: AgentSummary,
    credentialId: string,
    timestamp: string
  ): LocalAgentMetadata {
    const result = this.#database.prepare(`
      UPDATE local_agents
      SET status = ?, placement_id = ?, device_id = ?, generation = ?,
          credential_id = ?, activated_at = ?, last_verified_at = ?
      WHERE name = ? AND agent_id = ?
    `).run(
      summary.status,
      summary.placement.id,
      summary.placement.deviceId,
      summary.placement.generation,
      credentialId,
      summary.placement.activatedAt ?? timestamp,
      timestamp,
      summary.name,
      summary.id
    );
    if (result.changes !== 1) {
      throw new Error("local Agent metadata changed before activation");
    }
    return this.#require(summary.name);
  }

  public verify(summary: AgentSummary, timestamp: string): LocalAgentMetadata {
    const result = this.#database.prepare(`
      UPDATE local_agents
      SET status = ?, placement_id = ?, device_id = ?, generation = ?,
          activated_at = ?, last_verified_at = ?
      WHERE name = ? AND agent_id = ?
    `).run(
      summary.status,
      summary.placement.id,
      summary.placement.deviceId,
      summary.placement.generation,
      summary.placement.activatedAt ?? null,
      timestamp,
      summary.name,
      summary.id
    );
    if (result.changes !== 1) {
      throw new Error("local Agent metadata does not match Server response");
    }
    return this.#require(summary.name);
  }

  #require(name: string): LocalAgentMetadata {
    const metadata = this.get(name);
    if (metadata === undefined) {
      throw new Error(`local Agent metadata is missing: ${name}`);
    }
    return metadata;
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_agents (
        agent_id TEXT NOT NULL UNIQUE,
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'suspended', 'revoked')),
        placement_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        credential_id TEXT,
        workspace_path TEXT NOT NULL,
        agent_client TEXT NOT NULL DEFAULT 'codex'
          CHECK (agent_client = 'codex'),
        created_at TEXT NOT NULL,
        activated_at TEXT,
        last_verified_at TEXT
      );
    `);
    const columns = this.#database.prepare("PRAGMA table_info(local_agents)").all() as unknown as
      Array<{ name: string }>;
    if (!columns.some((column) => column.name === "agent_client")) {
      this.#database.exec(`
        ALTER TABLE local_agents ADD COLUMN agent_client TEXT NOT NULL DEFAULT 'codex'
          CHECK (agent_client = 'codex');
      `);
    }
    this.#database.exec(`
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '18')
      ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), 18);
    `);
  }
}

function fromRow(row: LocalAgentRow): LocalAgentMetadata {
  return {
    agentId: row.agent_id,
    name: row.name,
    status: row.status,
    placementId: row.placement_id,
    deviceId: row.device_id,
    generation: row.generation,
    workspacePath: row.workspace_path,
    client: row.agent_client,
    createdAt: row.created_at,
    ...(row.credential_id === null ? {} : { credentialId: row.credential_id }),
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    ...(row.last_verified_at === null ? {} : { lastVerifiedAt: row.last_verified_at })
  };
}
