import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface WebSearchGrant {
  readonly agentId: string;
  readonly ownerPrincipalId: string;
  readonly status: "active" | "revoked";
  readonly updatedAt: string;
}
interface Document {
  readonly schemaVersion: 1;
  readonly grants: readonly WebSearchGrant[];
}

/** Owner-private capability state; native search grant only; invocation evidence stays in existing Execution receipts. */
export class WebSearchAccessStore {
  constructor(readonly path: string) {}
  inspect(agentId: string) { return this.read().grants.find(grant => grant.agentId === agentId); }
  set(agentId: string, ownerPrincipalId: string, enabled: boolean): WebSearchGrant {
    const document = this.read();
    const current = document.grants.find(grant => grant.agentId === agentId);
    const status = enabled ? "active" : "revoked";
    if (current?.status === status && current.ownerPrincipalId === ownerPrincipalId) return current;
    const grant = { agentId, ownerPrincipalId, status, updatedAt: new Date().toISOString() } as const;
    this.write({ ...document, grants: [...document.grants.filter(grant => grant.agentId !== agentId), grant] });
    return grant;
  }
  private read(): Document {
    if (!existsSync(this.path)) return { schemaVersion: 1, grants: [] };
    const stat = lstatSync(this.path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1_048_576) {
      throw new Error("Web search access must be a private regular file up to 1 MiB");
    }
    const value = JSON.parse(readFileSync(this.path, "utf8")) as Document;
    if (value?.schemaVersion !== 1 || !Array.isArray(value.grants) ||
      !value.grants.every(grant => grant && typeof grant.agentId === "string" &&
        typeof grant.ownerPrincipalId === "string" &&
        typeof grant.updatedAt === "string" && ["active", "revoked"].includes(grant.status)) ||
      new Set(value.grants.map(grant => grant.agentId)).size !== value.grants.length) throw new Error("Invalid web search access policy");
    return value;
  }
  private write(value: Document): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
