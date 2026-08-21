import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";

export interface ActivityAccessGrant {
  readonly agentId: string;
  readonly scope: "owner-wide-read";
  readonly status: "active" | "revoked";
  readonly grantedAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

interface ActivityAccessDocument {
  readonly schemaVersion: 1;
  readonly grants: readonly ActivityAccessGrant[];
}

export class ActivityAccessStore {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public list(): readonly ActivityAccessGrant[] {
    return this.#read().grants;
  }

  public inspect(agentId: string): ActivityAccessGrant | undefined {
    return this.#read().grants.find((grant) => grant.agentId === agentId);
  }

  public grant(agentId: string, at: string): ActivityAccessGrant {
    requireIdentifier(agentId);
    requireTimestamp(at);
    const document = this.#read();
    const current = document.grants.find((grant) => grant.agentId === agentId);
    if (current?.status === "active") return current;
    const grant: ActivityAccessGrant = {
      agentId,
      scope: "owner-wide-read",
      status: "active",
      grantedAt: current?.grantedAt ?? at,
      updatedAt: at
    };
    this.#write({
      schemaVersion: 1,
      grants: [...document.grants.filter((item) => item.agentId !== agentId), grant]
    });
    return grant;
  }

  public revoke(agentId: string, at: string): ActivityAccessGrant | undefined {
    requireIdentifier(agentId);
    requireTimestamp(at);
    const document = this.#read();
    const current = document.grants.find((grant) => grant.agentId === agentId);
    if (current === undefined || current.status === "revoked") return current;
    const revoked: ActivityAccessGrant = {
      ...current,
      status: "revoked",
      updatedAt: at,
      revokedAt: at
    };
    this.#write({
      schemaVersion: 1,
      grants: [...document.grants.filter((item) => item.agentId !== agentId), revoked]
    });
    return revoked;
  }

  #read(): ActivityAccessDocument {
    if (!existsSync(this.#path)) return { schemaVersion: 1, grants: [] };
    if (lstatSync(this.#path).isSymbolicLink() || !statSync(this.#path).isFile()) {
      throw new Error("Activity access policy must be a regular file");
    }
    if ((statSync(this.#path).mode & 0o077) !== 0) {
      throw new Error("Activity access policy must be private to the owner");
    }
    const value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
    if (!isDocument(value)) throw new Error("Activity access policy has an unsupported schema");
    return value;
  }

  #write(document: ActivityAccessDocument): void {
    if (existsSync(this.#path) && lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("Activity access policy must not be a symlink");
    }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

function isDocument(value: unknown): value is ActivityAccessDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.grants)) return false;
  return value.grants.every((grant) => isRecord(grant) &&
    typeof grant.agentId === "string" && grant.scope === "owner-wide-read" &&
    (grant.status === "active" || grant.status === "revoked") &&
    typeof grant.grantedAt === "string" && typeof grant.updatedAt === "string" &&
    (grant.revokedAt === undefined || typeof grant.revokedAt === "string"));
}

function requireIdentifier(value: string): void {
  if (value.trim() === "" || value.length > 255 || value.includes("\0")) {
    throw new Error("Activity access Agent id is invalid");
  }
}

function requireTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value))) throw new Error("Activity access timestamp is invalid");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
