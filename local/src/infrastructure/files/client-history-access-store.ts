import { createHash, randomUUID } from "node:crypto";
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

import type { AgentClient } from "../../modules/agent/client-profile.js";

export interface ClientHistoryGrant {
  readonly grantId: string;
  readonly ownerPrincipalId: string;
  readonly agentId: string;
  readonly client: AgentClient;
  readonly scope: "same-client-history-read";
  readonly status: "active" | "revoked";
  readonly grantedAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

export interface ClientHistoryAudit {
  readonly auditId: string;
  readonly grantId: string;
  readonly ownerPrincipalId: string;
  readonly agentId: string;
  readonly client: AgentClient;
  readonly action: "grant" | "list" | "search" | "read" | "revoke";
  readonly requestDigest?: string;
  readonly resultCount?: number;
  readonly truncated?: boolean;
  readonly policyFingerprint?: string;
  readonly outcome?: "succeeded" | "failed";
  readonly failureReason?: string;
  readonly occurredAt: string;
}

interface ClientHistoryAccessDocument {
  readonly schemaVersion: 1;
  readonly grants: readonly ClientHistoryGrant[];
  readonly audits: readonly ClientHistoryAudit[];
}

export class ClientHistoryAccessStore {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public inspect(
    ownerPrincipalId: string,
    agentId: string,
    client: AgentClient
  ): ClientHistoryGrant | undefined {
    return this.#read().grants.find((grant) =>
      grant.ownerPrincipalId === ownerPrincipalId &&
      grant.agentId === agentId &&
      grant.client === client);
  }

  public listAudits(
    ownerPrincipalId: string,
    agentId?: string
  ): readonly ClientHistoryAudit[] {
    return this.#read().audits.filter((audit) =>
      audit.ownerPrincipalId === ownerPrincipalId &&
      (agentId === undefined || audit.agentId === agentId));
  }

  public grant(
    ownerPrincipalId: string,
    agentId: string,
    client: AgentClient,
    at: string
  ): ClientHistoryGrant {
    const document = this.#read();
    const current = document.grants.find((grant) =>
      grant.agentId === agentId && grant.client === client);
    if (current?.status === "active" && current.ownerPrincipalId === ownerPrincipalId) {
      return current;
    }
    const grant: ClientHistoryGrant = {
      grantId: current?.ownerPrincipalId === ownerPrincipalId
        ? current.grantId
        : `chg_${digest(`${ownerPrincipalId}:${agentId}:${client}`)}`,
      ownerPrincipalId: identifier(ownerPrincipalId, "ownerPrincipalId"),
      agentId: identifier(agentId, "agentId"),
      client,
      scope: "same-client-history-read",
      status: "active",
      grantedAt: current?.ownerPrincipalId === ownerPrincipalId
        ? current.grantedAt
        : timestamp(at),
      updatedAt: timestamp(at)
    };
    this.#write({
      schemaVersion: 1,
      grants: [...document.grants.filter((item) =>
        item.agentId !== agentId || item.client !== client), grant],
      audits: [...document.audits, audit(grant, "grant", at)].slice(-10_000)
    });
    return grant;
  }

  public revoke(
    ownerPrincipalId: string,
    agentId: string,
    client: AgentClient,
    at: string
  ): ClientHistoryGrant | undefined {
    const document = this.#read();
    const current = document.grants.find((grant) =>
      grant.agentId === agentId && grant.client === client);
    if (current === undefined || current.status === "revoked") return current;
    if (current.ownerPrincipalId !== ownerPrincipalId) {
      throw new Error("Client history grant belongs to another Owner");
    }
    const revoked: ClientHistoryGrant = {
      ...current,
      status: "revoked",
      updatedAt: timestamp(at),
      revokedAt: timestamp(at)
    };
    this.#write({
      schemaVersion: 1,
      grants: [...document.grants.filter((item) =>
        item.agentId !== agentId || item.client !== client), revoked],
      audits: [...document.audits, audit(revoked, "revoke", at)].slice(-10_000)
    });
    return revoked;
  }

  public recordAccess(input: {
    readonly grant: ClientHistoryGrant;
    readonly action: "list" | "search" | "read";
    readonly policyFingerprint?: string;
    readonly request: string;
    readonly resultCount: number;
    readonly truncated: boolean;
    readonly outcome: "succeeded" | "failed";
    readonly failureReason?: string;
    readonly at: string;
  }): void {
    const document = this.#read();
    const current = document.grants.find((grant) => grant.grantId === input.grant.grantId);
    if (current?.status !== "active" ||
      current.ownerPrincipalId !== input.grant.ownerPrincipalId ||
      current.agentId !== input.grant.agentId ||
      current.client !== input.grant.client) {
      throw new Error("Client history grant is not active");
    }
    if (input.policyFingerprint !== undefined &&
      !/^[a-f0-9]{64}$/.test(input.policyFingerprint)) {
      throw new Error("Client history policy fingerprint is invalid");
    }
    const accessAudit: ClientHistoryAudit = {
      ...audit(current, input.action, input.at),
      requestDigest: digest(input.request),
      resultCount: input.resultCount,
      truncated: input.truncated,
      ...(input.policyFingerprint === undefined
        ? {}
        : { policyFingerprint: input.policyFingerprint }),
      outcome: input.outcome,
      ...(input.failureReason === undefined
        ? {}
        : { failureReason: input.failureReason.slice(0, 255) })
    };
    this.#write({
      ...document,
      audits: [...document.audits, accessAudit].slice(-10_000)
    });
  }

  public recordDeniedAccess(input: {
    readonly grant: ClientHistoryGrant;
    readonly action: "list" | "search" | "read";
    readonly policyFingerprint?: string;
    readonly request: string;
    readonly failureReason: string;
    readonly at: string;
  }): void {
    const document = this.#read();
    const current = document.grants.find((grant) => grant.grantId === input.grant.grantId);
    if (current === undefined || current.ownerPrincipalId !== input.grant.ownerPrincipalId ||
      current.agentId !== input.grant.agentId || current.client !== input.grant.client) {
      throw new Error("Client history grant identity changed");
    }
    const denied = {
      ...audit(current, input.action, input.at),
      requestDigest: digest(input.request),
      resultCount: 0,
      truncated: false,
      ...(input.policyFingerprint === undefined
        ? {}
        : { policyFingerprint: input.policyFingerprint }),
      outcome: "failed" as const,
      failureReason: input.failureReason.slice(0, 255)
    };
    this.#write({
      ...document,
      audits: [...document.audits, denied].slice(-10_000)
    });
  }

  #read(): ClientHistoryAccessDocument {
    if (!existsSync(this.#path)) return { schemaVersion: 1, grants: [], audits: [] };
    if (lstatSync(this.#path).isSymbolicLink() || !statSync(this.#path).isFile() ||
      (statSync(this.#path).mode & 0o077) !== 0) {
      throw new Error("Client history access policy must be a private regular file");
    }
    const value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
    if (!isDocument(value)) {
      throw new Error("Client history access policy has an unsupported schema");
    }
    return value;
  }

  #write(document: ClientHistoryAccessDocument): void {
    if (existsSync(this.#path) && lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("Client history access policy must not be a symlink");
    }
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
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

function audit(
  grant: ClientHistoryGrant,
  action: ClientHistoryAudit["action"],
  at: string
): ClientHistoryAudit {
  return {
    auditId: `cha_${randomUUID()}`,
    grantId: grant.grantId,
    ownerPrincipalId: grant.ownerPrincipalId,
    agentId: grant.agentId,
    client: grant.client,
    action,
    occurredAt: timestamp(at)
  };
}

function isDocument(value: unknown): value is ClientHistoryAccessDocument {
  if (!record(value) || value.schemaVersion !== 1 ||
    !Array.isArray(value.grants) || !Array.isArray(value.audits)) return false;
  return value.grants.every((grant) => record(grant) &&
    typeof grant.grantId === "string" && typeof grant.ownerPrincipalId === "string" &&
    typeof grant.agentId === "string" && typeof grant.client === "string" &&
    grant.scope === "same-client-history-read" &&
    (grant.status === "active" || grant.status === "revoked") &&
    typeof grant.grantedAt === "string" && typeof grant.updatedAt === "string") &&
    value.audits.every((entry) => record(entry) &&
      typeof entry.auditId === "string" && typeof entry.grantId === "string" &&
      typeof entry.ownerPrincipalId === "string" && typeof entry.agentId === "string" &&
      typeof entry.client === "string" &&
      (entry.action === "grant" || entry.action === "list" || entry.action === "search" ||
        entry.action === "read" || entry.action === "revoke") &&
      (entry.policyFingerprint === undefined ||
        (typeof entry.policyFingerprint === "string" &&
          /^[a-f0-9]{64}$/.test(entry.policyFingerprint))) &&
      (entry.outcome === undefined ||
        entry.outcome === "succeeded" ||
        entry.outcome === "failed") &&
      (entry.failureReason === undefined || typeof entry.failureReason === "string") &&
      typeof entry.occurredAt === "string");
}

function identifier(value: string, field: string): string {
  if (value.trim() === "" || value.length > 255 || value.includes("\0")) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function timestamp(value: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error("timestamp is invalid");
  return new Date(value).toISOString();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
