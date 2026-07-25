import type { DatabaseSync } from "node:sqlite";

import type { AgentSummary } from "../../protocol.js";
import { openRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./local-schema.js";
import {
  agentClients,
  type AgentClient
} from "../../modules/agent/client-profile.js";

export { agentClients, type AgentClient };

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
    return [];
  }

  public get(name: string): LocalAgentMetadata | undefined {
    void name;
    return undefined;
  }

  public provision(
    summary: AgentSummary,
    workspacePath: string,
    client: AgentClient = "codex"
  ): LocalAgentMetadata {
    void summary;
    void workspacePath;
    void client;
    throw deferredServerBinding();
  }

  public activate(
    summary: AgentSummary,
    credentialId: string,
    timestamp: string
  ): LocalAgentMetadata {
    void summary;
    void credentialId;
    void timestamp;
    throw deferredServerBinding();
  }

  public verify(summary: AgentSummary, timestamp: string): LocalAgentMetadata {
    void summary;
    void timestamp;
    throw deferredServerBinding();
  }

  #migrate(): void {
    migrateLocalDatabase(this.#database);
  }
}

function deferredServerBinding(): Error {
  return new Error("Server Agent binding persistence is deferred to v0.4");
}
