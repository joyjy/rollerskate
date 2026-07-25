import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { agentNameSchema } from "../../protocol.js";

interface AgentCredentialBase {
  readonly serverUrl: string;
  readonly deviceId: string;
  readonly name: string;
  readonly verifier: string;
  readonly agentId?: string;
  readonly placementId?: string;
  readonly enrollmentId?: string;
}

export interface PendingAgentCredential extends AgentCredentialBase {
  readonly state: "pending";
}

export interface ActiveAgentCredential extends AgentCredentialBase {
  readonly state: "active";
  readonly agentId: string;
  readonly placementId: string;
  readonly enrollmentId: string;
  readonly credentialId: string;
  readonly credential: string;
}

export type AgentCredential = PendingAgentCredential | ActiveAgentCredential;

export class AgentCredentialStore {
  readonly #directory: string;

  public constructor(directory: string) {
    this.#directory = directory;
  }

  public load(name: string): AgentCredential | undefined {
    const path = this.#path(name);
    if (!existsSync(path)) {
      return undefined;
    }
    assertRegularPrivateFile(path);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `invalid Agent credential file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isStoredCredential(value) || value.name !== name) {
      throw new Error("Agent credential file has an unsupported schema");
    }
    const { schemaVersion: _schemaVersion, ...credential } = value;
    return credential;
  }

  public save(credential: AgentCredential): void {
    const path = this.#path(credential.name);
    this.#ensureDirectory();
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error("Agent credential file must not be a symlink");
    }
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: 1,
        ...credential
      }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    }
  }

  #path(name: string): string {
    agentNameSchema.parse(name);
    return join(this.#directory, `${name}.json`);
  }

  #ensureDirectory(): void {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.#directory).isSymbolicLink() || !statSync(this.#directory).isDirectory()) {
      throw new Error("Agent credential directory must be a regular directory");
    }
    chmodSync(this.#directory, 0o700);
  }
}

function isStoredCredential(value: unknown): value is AgentCredential & { schemaVersion: 1 } {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    (value.state !== "pending" && value.state !== "active")) {
    return false;
  }
  for (const field of ["serverUrl", "deviceId", "name", "verifier"] as const) {
    if (typeof value[field] !== "string" || value[field] === "") {
      return false;
    }
  }
  if (value.state === "active") {
    for (const field of [
      "agentId", "placementId", "enrollmentId", "credentialId", "credential"
    ] as const) {
      if (typeof value[field] !== "string" || value[field] === "") {
        return false;
      }
    }
  }
  return true;
}

function assertRegularPrivateFile(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("Agent credential file must not be a symlink");
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error("Agent credential path must be a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Agent credential file must not be accessible by group or others");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
