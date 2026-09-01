import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import { localId } from "../../core/id.js";
import { openInitializedRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./schema/index.js";
import {
  agentExecutionConfig,
  parseAgentExecutionConfig,
  type AgentExecutionConfig
} from "../../modules/agent/client-profile.js";
import {
  normalizeAgentHandle,
  type LocalAgent,
  type LocalAgentClient,
  type LocalFoundation,
  type LocalPrincipal,
  type PrincipalKind,
  type PrincipalStatus
} from "../../modules/foundation/model.js";
import type { RuntimePaths } from "../runtime/config.js";

interface FoundationRow {
  device_id: string;
  device_name: string;
  workspace_path: string;
  topic_id: string;
  topic_handle: "local";
  owner_principal_id: string;
  owner_handle: string;
  owner_status: PrincipalStatus;
  owner_created_at: string;
  owner_updated_at: string;
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
  readonly #ownsDatabase: boolean;

  public constructor(
    database: string | DatabaseSync,
    options: { readonly migrate?: boolean } = {}
  ) {
    this.#database = typeof database === "string"
      ? openInitializedRuntimeDatabase(database, migrateLocalDatabase)
      : database;
    this.#ownsDatabase = typeof database === "string";
    if (!this.#ownsDatabase && options.migrate !== false) this.#migrate();
  }

  public close(): void {
    if (this.#ownsDatabase) this.#database.close();
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
    this.#database.prepare(`
      INSERT INTO local_foundation (
        singleton, device_id, device_name, workspace_path, topic_id, topic_handle,
        owner_principal_id, owner_handle, owner_status, owner_created_at,
        owner_updated_at, created_at
      ) VALUES (1, ?, ?, ?, ?, 'local', ?, 'owner', 'active', ?, ?, ?)
    `).run(deviceId, deviceName, workspacePath, topicId, ownerId, at, at, at);
    return this.#fromFoundation(this.#requireFoundation());
  }

  public foundation(): LocalFoundation | undefined {
    const row = this.#foundation();
    return row === undefined ? undefined : this.#fromFoundation(row);
  }

  public listAgents(): readonly LocalAgent[] {
    return (this.#database.prepare(`
      SELECT principal_id, 'agent' AS kind, handle, status, created_at, updated_at,
             agent_client, execution_config
      FROM agents
      ORDER BY handle_key ASC
    `).all() as unknown as AgentRow[]).map(fromAgentRow);
  }

  public agentByHandle(handleInput: string): LocalAgent | undefined {
    const handle = normalizeAgentHandle(handleInput);
    const row = this.#database.prepare(`
      SELECT principal_id, 'agent' AS kind, handle, status, created_at, updated_at,
             agent_client, execution_config
      FROM agents
      WHERE handle_key = ?
    `).get(handle.key) as AgentRow | undefined;
    return row === undefined ? undefined : fromAgentRow(row);
  }

  public agent(principalId: string): LocalAgent | undefined {
    const row = this.#database.prepare(`
      SELECT principal_id, 'agent' AS kind, handle, status, created_at, updated_at,
             agent_client, execution_config
      FROM agents
      WHERE principal_id = ?
    `).get(principalId) as AgentRow | undefined;
    return row === undefined ? undefined : fromAgentRow(row);
  }

  public addAgent(
    handleInput: string,
    client: LocalAgentClient,
    at = new Date().toISOString(),
    executionConfigInput: AgentExecutionConfig = { launchArgs: [] }
  ): LocalAgent {
    const handle = normalizeAgentHandle(handleInput);
    const executionConfig = agentExecutionConfig(client, executionConfigInput.launchArgs);
    const principalId = localId("prn");
    try {
      this.#database.prepare(`
        INSERT INTO agents (
          principal_id, handle, handle_key, status, agent_client,
          execution_config, current_session_id, session_generation,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, NULL, 1, ?, ?)
      `).run(
        principalId,
        handle.value,
        handle.key,
        client,
        JSON.stringify(executionConfig),
        at,
        at
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new Error(`Agent handle is already in use: ${handle.value}`);
      }
      throw error;
    }
    return this.#requireAgent(principalId);
  }

  public configureAgent(
    principalId: string,
    launchArgs: readonly string[],
    at = new Date().toISOString()
  ): LocalAgent {
    const agent = this.#requireAgent(principalId);
    const executionConfig = agentExecutionConfig(agent.client, launchArgs);
    const result = this.#database.prepare(`
      UPDATE agents SET execution_config = ?, updated_at = ?
      WHERE principal_id = ?
    `).run(JSON.stringify(executionConfig), at, principalId);
    if (result.changes !== 1) throw new Error(`Local Agent not found: ${principalId}`);
    return this.#requireAgent(principalId);
  }

  public renameAgent(
    principalId: string,
    handleInput: string,
    at = new Date().toISOString()
  ): LocalAgent {
    const handle = normalizeAgentHandle(handleInput);
    try {
      const result = this.#database.prepare(`
        UPDATE agents
        SET handle = ?, handle_key = ?, updated_at = ?
        WHERE principal_id = ?
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
      UPDATE agents SET status = ?, updated_at = ?
      WHERE principal_id = ?
    `).run(status, at, principalId);
    if (result.changes !== 1) throw new Error(`Local Agent not found: ${principalId}`);
    return this.#requireAgent(principalId);
  }

  #foundation(): FoundationRow | undefined {
    return this.#database.prepare(`
      SELECT device_id, device_name, workspace_path, topic_id, topic_handle,
             owner_principal_id, owner_handle, owner_status, owner_created_at,
             owner_updated_at, created_at
      FROM local_foundation WHERE singleton = 1
    `).get() as FoundationRow | undefined;
  }

  #requireFoundation(): FoundationRow {
    const row = this.#foundation();
    if (row === undefined) throw new Error("Local foundation is missing after bootstrap");
    return row;
  }

  #fromFoundation(row: FoundationRow): LocalFoundation {
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      workspacePath: row.workspace_path,
      topicId: row.topic_id,
      topicHandle: row.topic_handle,
      owner: fromPrincipalRow({
        principal_id: row.owner_principal_id,
        kind: "owner",
        handle: row.owner_handle,
        status: row.owner_status,
        created_at: row.owner_created_at,
        updated_at: row.owner_updated_at
      }),
      createdAt: row.created_at
    };
  }

  #requireAgent(principalId: string): LocalAgent {
    const row = this.#database.prepare(`
      SELECT principal_id, 'agent' AS kind, handle, status, created_at, updated_at,
             agent_client, execution_config
      FROM agents
      WHERE principal_id = ?
    `).get(principalId) as AgentRow | undefined;
    if (row === undefined) throw new Error(`Local Agent not found: ${principalId}`);
    return fromAgentRow(row);
  }

  #migrate(): void {
    migrateLocalDatabase(this.#database);
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
  let executionConfig: AgentExecutionConfig;
  try {
    const value = JSON.parse(row.execution_config) as unknown;
    executionConfig = parseAgentExecutionConfig(row.agent_client, value);
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

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
