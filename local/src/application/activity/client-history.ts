import { homedir } from "node:os";
import { join } from "node:path";

import {
  ClientHistoryAccessStore,
  type ClientHistoryAudit,
  type ClientHistoryGrant
} from "../../infrastructure/files/client-history-access-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { ProviderActivitySource } from "../../integrations/activity/provider-source.js";
import {
  CodexThreadSource,
  type CodexThreadListInput,
  type CodexThreadListResult,
  type CodexThreadReadResult
} from "../../integrations/activity/codex-thread-source.js";
import { kimiProviderSessionId } from
  "../../integrations/agent/kimi-session-reference.js";
import type { AgentClient } from "../../modules/agent/client-profile.js";
import {
  verifyProviderPolicyReceipt,
  type ProviderPolicyReceipt
} from "../../modules/agent/activity-policy.js";
import type {
  ClientHistoryRequest,
  ClientHistoryResult
} from "../../core/chat/model.js";
import type { LocalControlOptions } from "../agent/control.js";

export interface ClientHistoryOptions extends LocalControlOptions {
  readonly homeDirectory?: string;
  readonly policyReceipt?: ProviderPolicyReceipt;
  readonly excludedProviderSessionId?: string;
  readonly sourceRoots?: Partial<Readonly<Record<AgentClient, string>>>;
  readonly archivedSourceRoots?: Partial<Readonly<Record<AgentClient, string>>>;
  readonly excludeSessionsStartedAtOrAfter?: string;
}

export interface CodexClientThreadListResult extends CodexThreadListResult {
  readonly schema: "CodexClientThreadListResult@1";
  readonly client: "codex";
  readonly timeZone: "Asia/Shanghai";
}

export interface CodexClientThreadReadResult extends CodexThreadReadResult {
  readonly schema: "CodexClientThreadReadResult@1";
  readonly client: "codex";
}

export function grantClientHistoryAccess(
  repoRoot: string,
  agentId: string,
  options: ClientHistoryOptions = {}
): ClientHistoryGrant {
  const context = agentContext(repoRoot, agentId, options);
  return accessStore(repoRoot, options).grant(
    context.ownerPrincipalId,
    agentId,
    context.client,
    now(options)
  );
}

export function inspectClientHistoryAccess(
  repoRoot: string,
  agentId: string,
  options: ClientHistoryOptions = {}
): ClientHistoryGrant | undefined {
  const context = agentContext(repoRoot, agentId, options);
  return accessStore(repoRoot, options).inspect(
    context.ownerPrincipalId,
    agentId,
    context.client
  );
}

export function revokeClientHistoryAccess(
  repoRoot: string,
  agentId: string,
  options: ClientHistoryOptions = {}
): ClientHistoryGrant | undefined {
  const context = agentContext(repoRoot, agentId, options);
  return accessStore(repoRoot, options).revoke(
    context.ownerPrincipalId,
    agentId,
    context.client,
    now(options)
  );
}

export function clientHistoryAudits(
  repoRoot: string,
  agentId: string,
  options: ClientHistoryOptions = {}
): readonly ClientHistoryAudit[] {
  const context = agentContext(repoRoot, agentId, options);
  return accessStore(repoRoot, options).listAudits(context.ownerPrincipalId, agentId);
}

export function queryClientHistory(
  repoRoot: string,
  agentId: string,
  request: ClientHistoryRequest,
  options: ClientHistoryOptions = {}
): ClientHistoryResult {
  const context = agentContext(repoRoot, agentId, options);
  const store = accessStore(repoRoot, options);
  const grant = store.inspect(context.ownerPrincipalId, agentId, context.client);
  if (grant?.status !== "active" ||
    grant.ownerPrincipalId !== context.ownerPrincipalId ||
    grant.client !== context.client) {
    throw new Error("Same-client history access is not granted");
  }
  let items: ClientHistoryResult["items"];
  let truncated = false;
  try {
    if (options.policyReceipt === undefined ||
      options.policyReceipt.client !== context.client) {
      throw new Error("Same-client history requires this Agent's provider policy receipt");
    }
    verifyProviderPolicyReceipt(options.policyReceipt, "same-client-history-read");
    const source = providerSource(context.client, options);
    if (request.action === "search") {
      const excludedProviderSessionId = context.client === "kimi-code"
        ? kimiProviderSessionId(options.excludedProviderSessionId)
        : options.excludedProviderSessionId;
      const search = source.search(request.query, request.limit, {
        ...(excludedProviderSessionId === undefined
          ? {}
          : { excludedSessionIds: new Set([excludedProviderSessionId]) })
      });
      truncated = search.truncated;
      items = search.records.map((record) => ({
        reference: record.reference,
        occurredAt: record.occurredAt,
        content: record.summary.slice(0, 512)
      }));
    } else {
      const record = source.readReference(request.reference);
      if (record === undefined) {
        throw new Error("Client history reference is unavailable");
      }
      items = [{
        reference: record.reference,
        occurredAt: record.occurredAt,
        content: record.summary
      }];
    }
  } catch (error) {
    store.recordAccess({
      grant,
      ...(options.policyReceipt === undefined
        ? {}
        : { policyFingerprint: options.policyReceipt.fingerprint }),
      action: request.action,
      request: request.action === "search" ? request.query : request.reference,
      resultCount: 0,
      truncated: false,
      outcome: "failed",
      failureReason: safeHistoryFailure(error),
      at: now(options)
    });
    throw error;
  }
  store.recordAccess({
    grant,
    policyFingerprint: options.policyReceipt.fingerprint,
    action: request.action,
    request: request.action === "search" ? request.query : request.reference,
    resultCount: items.length,
    truncated,
    outcome: "succeeded",
    at: now(options)
  });
  return {
    schema: "ClientHistoryResult@1",
    client: context.client,
    action: request.action,
    items,
    truncated
  };
}

export function listCodexClientThreads(
  repoRoot: string,
  agentId: string,
  request: CodexThreadListInput,
  options: ClientHistoryOptions = {}
): CodexClientThreadListResult {
  const authority = codexThreadAuthority(repoRoot, agentId, "list", request, options);
  try {
    const result = codexThreadSource(options).list(request);
    authority.store.recordAccess({
      grant: authority.grant,
      action: "list",
      policyFingerprint: authority.policyReceipt.fingerprint,
      request: JSON.stringify(request),
      resultCount: result.items.length,
      truncated: result.truncated,
      outcome: "succeeded",
      at: now(options)
    });
    return {
      schema: "CodexClientThreadListResult@1",
      client: "codex",
      timeZone: "Asia/Shanghai",
      ...result
    };
  } catch (error) {
    recordCodexThreadFailure(authority, "list", request, error, options);
    throw error;
  }
}

export function readCodexClientThread(
  repoRoot: string,
  agentId: string,
  reference: string,
  options: ClientHistoryOptions = {}
): CodexClientThreadReadResult {
  const authority = codexThreadAuthority(repoRoot, agentId, "read", reference, options);
  try {
    const result = codexThreadSource(options).read(reference);
    authority.store.recordAccess({
      grant: authority.grant,
      action: "read",
      policyFingerprint: authority.policyReceipt.fingerprint,
      request: reference,
      resultCount: result.messages.length,
      truncated: result.truncated,
      outcome: "succeeded",
      at: now(options)
    });
    return { schema: "CodexClientThreadReadResult@1", client: "codex", ...result };
  } catch (error) {
    recordCodexThreadFailure(authority, "read", reference, error, options);
    throw error;
  }
}

function safeHistoryFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/sources? (?:is|are) unavailable/i.test(message)) return "source-unavailable";
  if (/source is unsupported/i.test(message)) return "source-unsupported";
  if (/policy receipt|provider policy/i.test(message)) return "policy-rejected";
  if (/another client/i.test(message)) return "cross-client-reference";
  if (/reference is unavailable/i.test(message)) return "reference-unavailable";
  if (/not granted|grant is not active/i.test(message)) return "grant-inactive";
  return "history-read-failed";
}

function codexThreadAuthority(
  repoRoot: string,
  agentId: string,
  action: "list" | "read",
  request: CodexThreadListInput | string,
  options: ClientHistoryOptions
): {
  readonly store: ClientHistoryAccessStore;
  readonly grant: ClientHistoryGrant;
  readonly policyReceipt: ProviderPolicyReceipt;
} {
  const context = agentContext(repoRoot, agentId, options);
  if (context.client !== "codex") {
    throw new Error("Codex thread tools cannot read another client");
  }
  const store = accessStore(repoRoot, options);
  const grant = store.inspect(context.ownerPrincipalId, agentId, "codex");
  const requestText = typeof request === "string" ? request : JSON.stringify(request);
  if (grant?.status !== "active" || grant.ownerPrincipalId !== context.ownerPrincipalId) {
    if (grant !== undefined) {
      store.recordDeniedAccess({
        grant,
        action,
        ...(options.policyReceipt === undefined
          ? {}
          : { policyFingerprint: options.policyReceipt.fingerprint }),
        request: requestText,
        failureReason: "grant-inactive",
        at: now(options)
      });
    }
    throw new Error("Same-client history access is not granted");
  }
  if (options.policyReceipt === undefined || options.policyReceipt.client !== "codex") {
    store.recordAccess({
      grant,
      action,
      request: requestText,
      resultCount: 0,
      truncated: false,
      outcome: "failed",
      failureReason: "policy-rejected",
      at: now(options)
    });
    throw new Error("Codex thread tools require this Agent's provider policy receipt");
  }
  try {
    verifyProviderPolicyReceipt(options.policyReceipt, "same-client-history-read");
  } catch (error) {
    store.recordAccess({
      grant,
      policyFingerprint: options.policyReceipt.fingerprint,
      action,
      request: requestText,
      resultCount: 0,
      truncated: false,
      outcome: "failed",
      failureReason: "policy-rejected",
      at: now(options)
    });
    throw error;
  }
  return { store, grant, policyReceipt: options.policyReceipt };
}

function recordCodexThreadFailure(
  authority: {
    readonly store: ClientHistoryAccessStore;
    readonly grant: ClientHistoryGrant;
    readonly policyReceipt: ProviderPolicyReceipt;
  },
  action: "list" | "read",
  request: CodexThreadListInput | string,
  error: unknown,
  options: ClientHistoryOptions
): void {
  authority.store.recordAccess({
    grant: authority.grant,
    policyFingerprint: authority.policyReceipt.fingerprint,
    action,
    request: typeof request === "string" ? request : JSON.stringify(request),
    resultCount: 0,
    truncated: false,
    outcome: "failed",
    failureReason: safeHistoryFailure(error),
    at: now(options)
  });
}

function agentContext(
  repoRoot: string,
  agentId: string,
  options: ClientHistoryOptions
): { readonly client: AgentClient; readonly ownerPrincipalId: string } {
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  const foundation = new LocalFoundationStore(paths.database);
  try {
    const agent = foundation.listAgents().find((candidate) => candidate.principalId === agentId);
    if (agent === undefined || agent.status !== "active") {
      throw new Error("Client history access requires an active local Agent");
    }
    const local = foundation.foundation();
    if (local === undefined) throw new Error("Local foundation is not initialized");
    return {
      client: agent.client,
      ownerPrincipalId: local.owner.principalId
    };
  } finally {
    foundation.close();
  }
}

function providerSource(client: AgentClient, options: ClientHistoryOptions): ProviderActivitySource {
  const home = options.homeDirectory ?? homedir();
  const roots: Readonly<Record<AgentClient, string>> = {
    codex: options.sourceRoots?.codex ?? join(home, ".codex", "sessions"),
    "claude-code": options.sourceRoots?.["claude-code"] ?? join(home, ".claude", "projects"),
    "kimi-code": options.sourceRoots?.["kimi-code"] ?? join(home, ".kimi-code", "sessions"),
    pi: options.sourceRoots?.pi ?? join(home, ".pi", "agent", "sessions")
  };
  return new ProviderActivitySource(client, roots[client]);
}

function codexThreadSource(options: ClientHistoryOptions): CodexThreadSource {
  const home = options.homeDirectory ?? homedir();
  return new CodexThreadSource({
    activeRoot: options.sourceRoots?.codex ?? join(home, ".codex", "sessions"),
    archivedRoot: options.archivedSourceRoots?.codex ??
      join(home, ".codex", "archived_sessions"),
    ...(options.excludedProviderSessionId === undefined
      ? {}
      : { excludedSessionId: options.excludedProviderSessionId }),
    ...(options.excludeSessionsStartedAtOrAfter === undefined
      ? {}
      : { excludeStartedAtOrAfter: options.excludeSessionsStartedAtOrAfter })
  });
}

function accessStore(repoRoot: string, options: ClientHistoryOptions): ClientHistoryAccessStore {
  return new ClientHistoryAccessStore(
    runtimePaths(repoRoot, options.runtimeDirectory).clientHistoryAccess
  );
}

function now(options: ClientHistoryOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}
