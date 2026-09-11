import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { ActivityAccessStore } from "../../infrastructure/files/activity-access-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { ProviderActivitySource, redact } from
  "../../integrations/activity/provider-source.js";
import {
  verifyProviderPolicyReceipt,
  type ProviderPolicyReceipt
} from "../../modules/agent/activity-policy.js";
import type { AgentClient } from "../../modules/agent/client-profile.js";
import type { ActivityQueryResult, ActivityRecord } from "../../modules/activity/model.js";

export interface ActivityQueryOptions {
  readonly runtimeDirectory?: string;
  readonly homeDirectory?: string;
  readonly scope?: "agent" | "owner-wide";
  readonly limit?: number;
  readonly policyReceipt?: ProviderPolicyReceipt;
  readonly sourceRoots?: Partial<Readonly<Record<AgentClient, string>>>;
}

interface EventRow {
  readonly event_id: string;
  readonly agent_id: string | null;
  readonly prompt: string | null;
  readonly output: string | null;
  readonly error: string | null;
  readonly created_at: string;
}

interface SessionRow {
  readonly adapter_id: string;
  readonly provider_session_id: string;
}

export function queryLocalActivity(
  repoRoot: string,
  agentId: string,
  options: ActivityQueryOptions = {}
): ActivityQueryResult {
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  const foundationDatabase = openRuntimeDatabaseReadOnly(paths.database);
  let client: AgentClient;
  try {
    const foundation = new LocalFoundationStore(foundationDatabase, { migrate: false });
    const agent = foundation.listAgents().find((candidate) => candidate.principalId === agentId);
    if (agent === undefined || agent.status !== "active") {
      throw new Error("Activity query requires an active local Agent");
    }
    client = agent.client;
  } finally {
    foundationDatabase.close();
  }
  const scope = options.scope ?? "agent";
  if (scope === "owner-wide") {
    const grant = new ActivityAccessStore(paths.activityAccess).inspect(agentId);
    if (grant?.status !== "active") throw new Error("Owner-wide activity access is not granted");
    if (options.policyReceipt === undefined || options.policyReceipt.client !== client) {
      throw new Error("Owner-wide activity access requires this Agent's provider policy receipt");
    }
    verifyProviderPolicyReceipt(options.policyReceipt);
  }
  const limit = boundedLimit(options.limit ?? 50);
  const database = openRuntimeDatabaseReadOnly(paths.database);
  try {
    const ownSessions = providerSessions(database, agentId);
    const records = rollerskateRecords(database, agentId, scope, limit);
    const home = options.homeDirectory ?? homedir();
    const roots: Readonly<Record<AgentClient, string>> = {
      codex: options.sourceRoots?.codex ?? join(home, ".codex", "sessions"),
      "claude-code": options.sourceRoots?.["claude-code"] ?? join(home, ".claude", "projects"),
      "kimi-code": options.sourceRoots?.["kimi-code"] ?? join(home, ".kimi-code", "sessions"),
      pi: options.sourceRoots?.pi ?? join(home, ".pi", "agent", "sessions")
    };
    const sources = [
      new ProviderActivitySource("codex", roots.codex),
      new ProviderActivitySource("claude-code", roots["claude-code"]),
      new ProviderActivitySource("kimi-code", roots["kimi-code"]),
      new ProviderActivitySource("pi", roots.pi)
    ];
    const reads = sources.map((source) => source.read(
      scope === "owner-wide" ? undefined : ownSessions,
      limit
    ));
    const merged = [...records, ...reads.flatMap((read) => read.records)]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    return {
      scope,
      records: merged.slice(0, limit),
      coverage: [
        {
          source: "rollerskate",
          state: "available",
          detail: `queried bounded canonical history for ${scope} scope`
        },
        ...reads.map((read) => read.coverage)
      ],
      truncated: merged.length > limit
    };
  } finally {
    database.close();
  }
}

function rollerskateRecords(
  database: DatabaseSync,
  agentId: string,
  scope: "agent" | "owner-wide",
  limit: number
): ActivityRecord[] {
  const statement: StatementSync = scope === "agent"
    ? database.prepare(`
        SELECT event_id, agent_id, prompt, output, error, created_at
        FROM events WHERE agent_id = ? ORDER BY created_at DESC, event_id DESC LIMIT ?
      `)
    : database.prepare(`
        SELECT event_id, agent_id, prompt, output, error, created_at
        FROM events ORDER BY created_at DESC, event_id DESC LIMIT ?
      `);
  const rows = (scope === "agent" ? statement.all(agentId, limit) : statement.all(limit)) as
    unknown as EventRow[];
  return rows.map((row) => ({
    source: "rollerskate",
    sessionId: row.agent_id ?? "shared",
    occurredAt: row.created_at,
    summary: redact(row.prompt ?? row.output ?? row.error ?? "[event content unavailable]"),
    reference: `rollerskate:${digest(row.event_id)}`
  }));
}

function providerSessions(database: DatabaseSync, agentId: string): ReadonlySet<string> {
  const rows = database.prepare(`
    SELECT adapter_id, provider_session_id FROM agent_sessions WHERE agent_id = ?
  `).all(agentId) as unknown as SessionRow[];
  return new Set(rows.map((row) => row.provider_session_id));
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Activity query limit must be an integer from 1 to 100");
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
