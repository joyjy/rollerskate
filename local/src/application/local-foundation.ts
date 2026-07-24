import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import { localId } from "../core/id.js";
import { openRuntimeDatabase } from "../infrastructure/sqlite/database.js";
import type { RuntimePaths } from "./runtime-config.js";

export type PrincipalKind = "owner" | "agent";
export type PrincipalStatus = "active" | "suspended";
export type LocalAgentClient = "codex";

export interface LocalPrincipal {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  readonly handle: string;
  readonly status: PrincipalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalAgent {
  readonly principalId: string;
  readonly handle: string;
  readonly status: PrincipalStatus;
  readonly client: LocalAgentClient;
  readonly executionConfig: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalFoundation {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly workspacePath: string;
  readonly topicId: string;
  readonly topicHandle: "local";
  readonly owner: LocalPrincipal;
  readonly createdAt: string;
}

interface FoundationRow {
  device_id: string;
  device_name: string;
  workspace_path: string;
  topic_id: string;
  topic_handle: "local";
  owner_principal_id: string;
  created_at: string;
}

interface PrincipalRow {
  principal_id: string;
  kind: PrincipalKind;
  handle: string;
  status: PrincipalStatus;
  created_at: string;
  updated_at: string;
}

interface AgentRow extends PrincipalRow {
  agent_client: LocalAgentClient;
  execution_config: string;
}

export class LocalFoundationStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = openRuntimeDatabase(databasePath);
    this.#migrate();
  }

  public close(): void {
    this.#database.close();
  }

  public bootstrap(paths: RuntimePaths, at = new Date().toISOString()): LocalFoundation {
    ensurePrivateDirectory(paths.runtimeDirectory);
    ensurePrivateDirectory(paths.workspace);
    const existing = this.#foundation();
    if (existing !== undefined) {
      if (existing.workspace_path !== realpathSync(paths.workspace)) {
        throw new Error("LocalWorkspace path does not match this Runtime home");
      }
      return this.#fromFoundation(existing);
    }

    const ownerId = localId("prn");
    const deviceId = localId("dev");
    const topicId = localId("top");
    const deviceName = hostname().trim() || "local-device";
    const workspacePath = realpathSync(paths.workspace);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO local_principals (
          principal_id, kind, handle, handle_key, status, created_at, updated_at
        ) VALUES (?, 'owner', 'owner', 'owner', 'active', ?, ?)
      `).run(ownerId, at, at);
      this.#database.prepare(`
        INSERT INTO local_foundation (
          singleton, device_id, device_name, workspace_path, topic_id, topic_handle,
          owner_principal_id, created_at
        ) VALUES (1, ?, ?, ?, ?, 'local', ?, ?)
      `).run(deviceId, deviceName, workspacePath, topicId, ownerId, at);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#fromFoundation(this.#requireFoundation());
  }

  public foundation(): LocalFoundation | undefined {
    const row = this.#foundation();
    return row === undefined ? undefined : this.#fromFoundation(row);
  }

  public listAgents(): readonly LocalAgent[] {
    return (this.#database.prepare(`
      SELECT p.principal_id, p.kind, p.handle, p.status, p.created_at, p.updated_at,
             a.agent_client, a.execution_config
      FROM local_principals p
      JOIN local_agent_profiles a ON a.principal_id = p.principal_id
      WHERE p.kind = 'agent'
      ORDER BY p.handle_key ASC
    `).all() as unknown as AgentRow[]).map(fromAgentRow);
  }

  public agentByHandle(handleInput: string): LocalAgent | undefined {
    const handle = normalizeHandle(handleInput);
    const row = this.#database.prepare(`
      SELECT p.principal_id, p.kind, p.handle, p.status, p.created_at, p.updated_at,
             a.agent_client, a.execution_config
      FROM local_principals p
      JOIN local_agent_profiles a ON a.principal_id = p.principal_id
      WHERE p.kind = 'agent' AND p.handle_key = ?
    `).get(handle.key) as AgentRow | undefined;
    return row === undefined ? undefined : fromAgentRow(row);
  }

  public agent(principalId: string): LocalAgent | undefined {
    const row = this.#database.prepare(`
      SELECT p.principal_id, p.kind, p.handle, p.status, p.created_at, p.updated_at,
             a.agent_client, a.execution_config
      FROM local_principals p
      JOIN local_agent_profiles a ON a.principal_id = p.principal_id
      WHERE p.principal_id = ? AND p.kind = 'agent'
    `).get(principalId) as AgentRow | undefined;
    return row === undefined ? undefined : fromAgentRow(row);
  }

  public addAgent(
    handleInput: string,
    client: LocalAgentClient,
    at = new Date().toISOString()
  ): LocalAgent {
    const handle = normalizeHandle(handleInput);
    const principalId = localId("prn");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO local_principals (
          principal_id, kind, handle, handle_key, status, created_at, updated_at
        ) VALUES (?, 'agent', ?, ?, 'active', ?, ?)
      `).run(principalId, handle.value, handle.key, at, at);
      this.#database.prepare(`
        INSERT INTO local_agent_profiles (principal_id, agent_client, execution_config)
        VALUES (?, ?, '{}')
      `).run(principalId, client);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      if (isUniqueConstraint(error)) {
        throw new Error(`Agent handle is already in use: ${handle.value}`);
      }
      throw error;
    }
    return this.#requireAgent(principalId);
  }

  public renameAgent(
    principalId: string,
    handleInput: string,
    at = new Date().toISOString()
  ): LocalAgent {
    const handle = normalizeHandle(handleInput);
    try {
      const result = this.#database.prepare(`
        UPDATE local_principals
        SET handle = ?, handle_key = ?, updated_at = ?
        WHERE principal_id = ? AND kind = 'agent'
      `).run(handle.value, handle.key, at, principalId);
      if (result.changes !== 1) throw new Error(`Local Agent not found: ${principalId}`);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new Error(`Agent handle is already in use: ${handle.value}`);
      }
      throw error;
    }
    return this.#requireAgent(principalId);
  }

  public setAgentStatus(
    principalId: string,
    status: PrincipalStatus,
    at = new Date().toISOString()
  ): LocalAgent {
    const result = this.#database.prepare(`
      UPDATE local_principals SET status = ?, updated_at = ?
      WHERE principal_id = ? AND kind = 'agent'
    `).run(status, at, principalId);
    if (result.changes !== 1) throw new Error(`Local Agent not found: ${principalId}`);
    return this.#requireAgent(principalId);
  }

  #foundation(): FoundationRow | undefined {
    return this.#database.prepare(`
      SELECT device_id, device_name, workspace_path, topic_id, topic_handle,
             owner_principal_id, created_at
      FROM local_foundation WHERE singleton = 1
    `).get() as FoundationRow | undefined;
  }

  #requireFoundation(): FoundationRow {
    const row = this.#foundation();
    if (row === undefined) throw new Error("Local foundation is missing after bootstrap");
    return row;
  }

  #fromFoundation(row: FoundationRow): LocalFoundation {
    const owner = this.#database.prepare(`
      SELECT principal_id, kind, handle, status, created_at, updated_at
      FROM local_principals WHERE principal_id = ?
    `).get(row.owner_principal_id) as PrincipalRow | undefined;
    if (owner === undefined || owner.kind !== "owner") {
      throw new Error("Local Owner Principal is missing");
    }
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      workspacePath: row.workspace_path,
      topicId: row.topic_id,
      topicHandle: row.topic_handle,
      owner: fromPrincipalRow(owner),
      createdAt: row.created_at
    };
  }

  #requireAgent(principalId: string): LocalAgent {
    const row = this.#database.prepare(`
      SELECT p.principal_id, p.kind, p.handle, p.status, p.created_at, p.updated_at,
             a.agent_client, a.execution_config
      FROM local_principals p
      JOIN local_agent_profiles a ON a.principal_id = p.principal_id
      WHERE p.principal_id = ? AND p.kind = 'agent'
    `).get(principalId) as AgentRow | undefined;
    if (row === undefined) throw new Error(`Local Agent not found: ${principalId}`);
    return fromAgentRow(row);
  }

  #migrate(): void {
    this.#migrateLocalChatNames();
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS local_principals (
        principal_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('owner', 'agent')),
        handle TEXT NOT NULL,
        handle_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_agent_profiles (
        principal_id TEXT PRIMARY KEY REFERENCES local_principals(principal_id),
        agent_client TEXT NOT NULL CHECK (agent_client = 'codex'),
        execution_config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_foundation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        device_id TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        topic_id TEXT NOT NULL UNIQUE,
        topic_handle TEXT NOT NULL UNIQUE CHECK (topic_handle = 'local'),
        owner_principal_id TEXT NOT NULL UNIQUE REFERENCES local_principals(principal_id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS server_connections (
        connection_id TEXT PRIMARY KEY,
        server_url TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('inactive', 'active')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_server_connection
        ON server_connections(status) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS server_device_bindings (
        local_device_id TEXT NOT NULL,
        server_connection_id TEXT NOT NULL REFERENCES server_connections(connection_id),
        remote_device_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('inactive', 'active')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (local_device_id, server_connection_id)
      );
      CREATE TABLE IF NOT EXISTS server_agent_bindings (
        principal_id TEXT NOT NULL REFERENCES local_principals(principal_id),
        server_connection_id TEXT NOT NULL REFERENCES server_connections(connection_id),
        remote_agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('inactive', 'active')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (principal_id, server_connection_id)
      );
      CREATE TABLE IF NOT EXISTS local_agent_sessions (
        principal_id TEXT PRIMARY KEY REFERENCES local_principals(principal_id),
        current_session_id TEXT,
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_chat_dispatches (
        source_message_event_id TEXT PRIMARY KEY,
        dispatch_event_id TEXT NOT NULL UNIQUE,
        target_principal_id TEXT NOT NULL REFERENCES local_principals(principal_id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_chat_prompts (
        source_message_event_id TEXT PRIMARY KEY,
        prompt_event_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
  }

  #migrateLocalChatNames(): void {
    const columns = new Set((this.#database.prepare(`
      PRAGMA table_info(local_foundation)
    `).all() as unknown as Array<{ name: string }>).map(({ name }) => name));
    if (columns.has("room_id")) {
      this.#database.exec(`
        ALTER TABLE local_foundation RENAME COLUMN room_id TO topic_id;
        ALTER TABLE local_foundation RENAME COLUMN room_handle TO topic_handle;
      `);
    }
    const tables = new Set((this.#database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as unknown as Array<{ name: string }>).map(({ name }) => name));
    if (tables.has("local_room_dispatches")) {
      this.#database.exec(`
        ALTER TABLE local_room_dispatches RENAME TO local_chat_dispatches;
      `);
    }
    if (tables.has("local_room_prompts")) {
      this.#database.exec(`
        ALTER TABLE local_room_prompts RENAME TO local_chat_prompts;
      `);
    }
  }
}

export function bootstrapLocalFoundation(
  paths: RuntimePaths,
  at = new Date().toISOString()
): LocalFoundation {
  const store = new LocalFoundationStore(paths.database);
  try {
    return store.bootstrap(paths, at);
  } finally {
    store.close();
  }
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
      throw new Error(`Runtime infrastructure path must be a regular directory: ${path}`);
    }
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

function normalizeHandle(input: string): { readonly value: string; readonly key: string } {
  const value = input.trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u.test(value)) {
    throw new Error(
      "Agent handle must be 1-32 letters or numbers, with optional internal _ or -"
    );
  }
  return { value, key: value.toLocaleLowerCase("und") };
}

function fromPrincipalRow(row: PrincipalRow): LocalPrincipal {
  return {
    principalId: row.principal_id,
    kind: row.kind,
    handle: row.handle,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function fromAgentRow(row: AgentRow): LocalAgent {
  let executionConfig: Readonly<Record<string, unknown>>;
  try {
    const value = JSON.parse(row.execution_config) as unknown;
    executionConfig = isRecord(value) ? value : {};
  } catch {
    throw new Error(`Local Agent execution config is invalid: ${row.principal_id}`);
  }
  return {
    principalId: row.principal_id,
    handle: row.handle,
    status: row.status,
    client: row.agent_client,
    executionConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
