import {
  type ChatAttentionReceipt,
  type ChatDecisionReceipt
} from "../../../infrastructure/sqlite/runtime-mappers.js";
import {
  parseChatPresence,
  parseChatRunProposalDraft
} from "../../chat/model.js";
import type {
  ChatAttentionPlan,
  ChatAttentionReason
} from "../../chat/state-machine.js";
import {
  eventSourceKinds,
  eventTypes,
  requireEventId,
  type CreateEvent,
  type SubscriptionAgentInvocation
} from "../../event/model.js";
import type {
  AgentInvocationDiagnostics,
  AgentInvocationFailure,
  AgentInvocationProgress
} from "../agent-invocation.js";
import type { AgentRunContext, RuntimeDestination } from "../model.js";

export interface DestinationSnapshot {
  readonly destinationId: string;
  readonly kind: RuntimeDestination["kind"];
  readonly address: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function annealedRetryAt(
  at: string,
  attempt: number,
  baseMilliseconds: number,
  maximumMilliseconds = 300_000
): string {
  bounded(attempt, 1, 30, "attempt");
  bounded(baseMilliseconds, 1, 86_400_000, "baseMilliseconds");
  bounded(maximumMilliseconds, 1, 86_400_000, "maximumMilliseconds");
  const delay = Math.min(maximumMilliseconds, baseMilliseconds * (2 ** (attempt - 1)));
  return new Date(Date.parse(iso(at)) + delay).toISOString();
}

export function validateCreateEvent(input: CreateEvent): void {
  if (!eventTypes.includes(input.type)) throw new Error(`unsupported Event type: ${input.type}`);
  if (!eventSourceKinds.includes(input.source.kind)) {
    throw new Error(`unsupported Event source: ${input.source.kind}`);
  }
  requireText(input.agentId, "agentId");
  requireText(input.prompt, "prompt");
  if (input.type === "subscription.fire") {
    if (input.observation === undefined || input.runContext !== undefined) {
      throw new Error("subscription.fire requires observation only");
    }
    if (input.subscriptionInvocation !== undefined) {
      validateSubscriptionAgentInvocation(input.subscriptionInvocation);
    }
  } else if (input.observation !== undefined) {
    throw new Error("agent.request does not accept observation");
  } else if (input.subscriptionInvocation !== undefined) {
    throw new Error("agent.request does not accept subscriptionInvocation");
  }
  if (input.runContext !== undefined) validateAgentRunContext(input.runContext);
  if (input.source.externalId !== undefined) requireText(input.source.externalId, "source.externalId");
  if (input.parent !== undefined) bounded(input.parent.hop, 0, 1_000, "parent.hop");
}

function validateSubscriptionAgentInvocation(
  invocation: SubscriptionAgentInvocation
): void {
  if (invocation.schemaVersion !== "SubscriptionAgentInvocation@1" ||
    invocation.resultSchema !== "SubscriptionAgentResult@1" ||
    typeof invocation.networkAccess !== "boolean") {
    throw new Error("subscription Agent invocation is malformed");
  }
  const grant = invocation.workspaceGrant;
  requireText(grant.root, "subscriptionInvocation.workspaceGrant.root");
  requireText(grant.revision, "subscriptionInvocation.workspaceGrant.revision");
  if (grant.schemaVersion !== "ExternalWorkspaceGrant@1" ||
    (grant.access !== "read" && grant.access !== "write")) {
    throw new Error("subscription Agent workspace grant is malformed");
  }
  if (invocation.networkAccess && grant.access !== "write") {
    throw new Error("subscription Agent network access requires write workspace access");
  }
}

function validateAgentRunContext(context: AgentRunContext): void {
  if (context.schemaVersion !== "AgentRunContext@1") {
    throw new Error("runContext schema is unsupported");
  }
  requireText(context.resultContractId, "runContext.resultContractId");
  requireText(context.runId, "runContext.runId");
  if (context.cycleId !== undefined) {
    requireText(context.cycleId, "runContext.cycleId");
  }
  requireText(context.stepId, "runContext.stepId");
  bounded(context.depth, 0, 100, "runContext.depth");
  if (context.parentStepId !== undefined) {
    requireText(context.parentStepId, "runContext.parentStepId");
  }
  if (context.invocationBudget !== undefined) {
    if (context.invocationBudget.schemaVersion !== "AgentInvocationBudget@1") {
      throw new Error("runContext invocation budget is malformed");
    }
    bounded(
      context.invocationBudget.totalTimeoutMilliseconds,
      1,
      900_000,
      "runContext.invocationBudget.totalTimeoutMilliseconds"
    );
  }
  if (context.workspaceGrant !== undefined) {
    requireText(context.workspaceGrant.root, "runContext.workspaceGrant.root");
    requireText(context.workspaceGrant.revision, "runContext.workspaceGrant.revision");
    if (context.workspaceGrant.schemaVersion !== "ExternalWorkspaceGrant@1" ||
      (context.workspaceGrant.access !== "read" &&
        context.workspaceGrant.access !== "write") ||
      (context.workspaceGrant.networkAccess !== undefined &&
        typeof context.workspaceGrant.networkAccess !== "boolean") ||
      (context.workspaceGrant.effect !== undefined &&
        context.workspaceGrant.effect !== "must_change" &&
        context.workspaceGrant.effect !== "may_remain_unchanged") ||
      (context.workspaceGrant.effect !== undefined &&
        context.workspaceGrant.access !== "write")) {
      throw new Error("runContext workspace grant is malformed");
    }
  }
  if (context.completionBinding !== undefined) {
    const binding = context.completionBinding;
    if (binding.schemaVersion !== "AgentCompletionBinding@1") {
      throw new Error("runContext completion binding is malformed");
    }
    requireText(binding.callerAgentId, "completionBinding.callerAgentId");
    requireText(binding.callerSessionId, "completionBinding.callerSessionId");
    requireText(binding.callerStepId, "completionBinding.callerStepId");
    requireEventId(binding.callerRequestEventId, "completionBinding.callerRequestEventId");
  }
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > 65_536) {
    throw new Error("runContext exceeds 65536 bytes");
  }
}

export function validateAddress(address: Readonly<Record<string, string>>): void {
  const entries = Object.entries(address);
  if (entries.length === 0) throw new Error("Destination address must not be empty");
  if (entries.length > 32) throw new Error("Destination address must contain at most 32 fields");
  for (const [key, value] of entries) {
    requireText(key, "Destination address key");
    requireText(value, `Destination address ${key}`);
    if (key.length > 128) throw new Error("Destination address key is too long");
    if (value.length > 4_096) {
      throw new Error(`Destination address ${key} exceeds 4096 characters`);
    }
  }
}

export function chatAttentionReceipt(
  sourceMessageEventId: string,
  plan: ChatAttentionPlan,
  dispatchEventId: string | undefined,
  promptResourceId: string | undefined,
  at: string
): ChatAttentionReceipt {
  return {
    sourceMessageEventId,
    agentId: plan.agentId,
    handleSnapshot: plan.handle,
    outcome: plan.outcome === "dispatch" ? "dispatched" : "skipped",
    reason: plan.reason,
    presenceSnapshot: plan.presenceSnapshot,
    ...(dispatchEventId === undefined ? {} : { dispatchEventId }),
    ...(promptResourceId === undefined ? {} : { promptResourceId }),
    createdAt: at
  };
}

export function parseChatAttentionReceiptList(value: string | null): ChatAttentionReceipt[] {
  if (value === null) return [];
  const parsed = parseJsonObject(value, "Execution receipt");
  if (parsed.schema !== "ChatAttentionReceiptList@1" ||
    !Array.isArray(parsed.receipts)) {
    return [];
  }
  return parsed.receipts.map((entry, index) => {
    if (!isRecord(entry) ||
      typeof entry.sourceMessageEventId !== "string" ||
      typeof entry.agentId !== "string" ||
      (entry.handleSnapshot !== undefined && typeof entry.handleSnapshot !== "string") ||
      (entry.outcome !== "dispatched" && entry.outcome !== "skipped") ||
      typeof entry.reason !== "string" ||
      !isRecord(entry.presenceSnapshot) ||
      typeof entry.createdAt !== "string") {
      throw new Error(`Chat attention receipt ${index} is malformed`);
    }
    return {
      sourceMessageEventId: entry.sourceMessageEventId,
      agentId: entry.agentId,
      handleSnapshot: typeof entry.handleSnapshot === "string"
        ? entry.handleSnapshot
        : entry.agentId,
      outcome: entry.outcome,
      reason: entry.reason as ChatAttentionReason,
      presenceSnapshot: entry.presenceSnapshot as ChatAttentionPlan["presenceSnapshot"],
      ...(typeof entry.dispatchEventId === "string"
        ? { dispatchEventId: entry.dispatchEventId }
        : {}),
      ...(typeof entry.promptResourceId === "string"
        ? { promptResourceId: entry.promptResourceId }
        : {}),
      createdAt: entry.createdAt
    };
  });
}

export function parseChatDecisionReceipt(value: string | null): ChatDecisionReceipt | undefined {
  if (value === null) return undefined;
  const parsed = parseJsonObject(value, "Execution receipt");
  if (parsed.schema !== "ChatDecisionReceipt@1" &&
    parsed.schema !== "ChatDecisionReceipt@2") return undefined;
  if ((parsed.sessionId !== undefined &&
      (typeof parsed.sessionId !== "string" || !/^ses_[A-Za-z0-9_-]+$/u.test(parsed.sessionId))) ||
    typeof parsed.dispatchEventId !== "string" ||
    (parsed.speechAction !== "reply" && parsed.speechAction !== "silent" &&
      parsed.speechAction !== "propose_run") ||
    (parsed.speechAction === "propose_run" && parsed.schema !== "ChatDecisionReceipt@2") ||
    (parsed.speechAction === "silent" && parsed.silenceReason !== undefined &&
      (typeof parsed.silenceReason !== "string" ||
        parsed.silenceReason.trim() === "" || parsed.silenceReason.length > 200)) ||
    typeof parsed.createdAt !== "string") {
    throw new Error("Chat decision receipt is malformed");
  }
  const proposal = parsed.proposal === undefined
    ? undefined
    : parseChatRunProposalDraft(parsed.proposal);
  if ((parsed.speechAction === "propose_run") !== (proposal !== undefined)) {
    throw new Error("Chat decision proposal receipt is malformed");
  }
  const presence = parsed.presenceTransition === undefined
    ? undefined
    : parseChatPresence(parsed.presenceTransition, parsed.createdAt);
  const profile = parsed.profileRevisions;
  if (profile !== undefined && (!isRecord(profile) ||
    profile.schema !== "ChatProfileRevisionReceipt@1" ||
    typeof profile.agentId !== "string" || !Number.isInteger(profile.agentRevision) ||
    (profile.agentRevision as number) < 1 || typeof profile.topicId !== "string" ||
    !Number.isInteger(profile.topicRevision) || (profile.topicRevision as number) < 1 ||
    typeof profile.resolvedAt !== "string" || Number.isNaN(Date.parse(profile.resolvedAt)))) {
    throw new Error("Chat profile revision receipt is malformed");
  }
  return {
    dispatchEventId: parsed.dispatchEventId,
    ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
    speechAction: parsed.speechAction,
    ...(parsed.speechAction === "silent" && typeof parsed.silenceReason === "string"
      ? { silenceReason: parsed.silenceReason as string }
      : {}),
    ...(proposal === undefined ? {} : { proposal }),
    ...(presence === undefined ? {} : { presenceTransition: presence }),
    ...(typeof parsed.replyEventId === "string" ? { replyEventId: parsed.replyEventId } : {}),
    ...(profile === undefined
      ? {}
      : {
          profileRevisions: {
            schema: "ChatProfileRevisionReceipt@1" as const,
            agentId: profile.agentId as string,
            agentRevision: profile.agentRevision as number,
            topicId: profile.topicId as string,
            topicRevision: profile.topicRevision as number,
            resolvedAt: profile.resolvedAt as string
          }
        }),
    createdAt: parsed.createdAt
  };
}

export function parseAgentInvocationReceipt(
  value: string | null,
  nested = false
): AgentInvocationDiagnostics | undefined {
  if (value === null) return undefined;
  const receipt = parseJsonObject(value, "Execution receipt");
  if ((!nested && receipt.schema !== "AgentInvocationReceipt@1") ||
    (nested && receipt.schema !== "ChatDecisionReceipt@1" &&
      receipt.schema !== "ChatDecisionReceipt@2")) {
    return undefined;
  }
  const candidate = receipt.invocation;
  if (candidate === undefined) return undefined;
  if (!isRecord(candidate) ||
    candidate.schemaVersion !== "AgentInvocationDiagnostics@1" ||
    typeof candidate.effectivePrompt !== "string" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.completedAt !== "string" ||
    typeof candidate.durationMilliseconds !== "number" ||
    !Number.isFinite(candidate.durationMilliseconds) ||
    candidate.durationMilliseconds < 0) {
    throw new Error("Agent invocation receipt is malformed");
  }
  const tokenUsage = candidate.tokenUsage;
  if (tokenUsage !== undefined && (!isRecord(tokenUsage) ||
    !validOptionalNumbers(tokenUsage, [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
      "totalTokens",
      "costUsd"
    ]))) {
    throw new Error("Agent invocation token usage is malformed");
  }
  const toolUsage = candidate.toolUsage;
  if (toolUsage !== undefined && (!Array.isArray(toolUsage) ||
    toolUsage.some((entry) => !isRecord(entry) ||
      typeof entry.name !== "string" || entry.name.trim() === "" ||
      typeof entry.count !== "number" || !Number.isInteger(entry.count) || entry.count < 1))) {
    throw new Error("Agent invocation tool usage is malformed");
  }
  if (candidate.turnCount !== undefined &&
    (typeof candidate.turnCount !== "number" ||
      !Number.isInteger(candidate.turnCount) || candidate.turnCount < 0)) {
    throw new Error("Agent invocation turn count is malformed");
  }
  return {
    schemaVersion: "AgentInvocationDiagnostics@1",
    effectivePrompt: candidate.effectivePrompt,
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
    durationMilliseconds: candidate.durationMilliseconds,
    ...(tokenUsage === undefined
      ? {}
      : {
          tokenUsage: tokenUsage as NonNullable<AgentInvocationDiagnostics["tokenUsage"]>
        }),
    ...(toolUsage === undefined
      ? {}
      : { toolUsage: toolUsage as unknown as NonNullable<AgentInvocationDiagnostics["toolUsage"]> }),
    ...(candidate.turnCount === undefined ? {} : { turnCount: candidate.turnCount })
  };
}

export function parseAgentInvocationProgressReceipt(
  value: string | null
): AgentInvocationProgress | undefined {
  const candidate = invocationTraceCandidate(value, "AgentInvocationProgressReceipt@1");
  if (candidate === undefined) return undefined;
  return normalizeAgentInvocationProgress(candidate as unknown as AgentInvocationProgress);
}

export function parseAgentInvocationFailureReceipt(
  value: string | null
): AgentInvocationFailure | undefined {
  const candidate = invocationTraceCandidate(value, "AgentInvocationFailureReceipt@1");
  if (candidate === undefined) return undefined;
  return normalizeAgentInvocationFailure(candidate as unknown as AgentInvocationFailure);
}

export function normalizeAgentInvocationProgress(
  value: AgentInvocationProgress
): AgentInvocationProgress {
  const candidate = value as unknown as Readonly<Record<string, unknown>>;
  if (candidate.schemaVersion !== "AgentInvocationProgress@1") {
    throw new Error("Agent invocation progress receipt is malformed");
  }
  return {
    schemaVersion: "AgentInvocationProgress@1",
    ...normalizedAgentInvocationProgress(candidate)
  };
}

export function normalizeAgentInvocationFailure(
  value: AgentInvocationFailure
): AgentInvocationFailure {
  const candidate = value as unknown as Readonly<Record<string, unknown>>;
  if (candidate.schemaVersion !== "AgentInvocationFailure@1") {
    throw new Error("Agent invocation failure receipt is malformed");
  }
  const progress = normalizedAgentInvocationProgress(candidate);
  if (typeof candidate.failedAt !== "string" ||
    !["stall", "deadline", "protocol_exit", "cancelled", "protocol_error"]
      .includes(candidate.reason as string) ||
    (candidate.reason === "deadline" && candidate.totalTimeoutMilliseconds === undefined) ||
    (candidate.totalTimeoutMilliseconds !== undefined &&
      !validBoundedInteger(candidate.totalTimeoutMilliseconds, 1, 900_000)) ||
    !validBoundedInteger(candidate.meaningfulOutputTimeoutMilliseconds, 1, 900_000) ||
    !["requested", "acknowledged", "unavailable"]
      .includes(candidate.protocolStop as string) ||
    !["explicit_read_only_resume", "unknown_outcome_no_replay", "none"]
      .includes(candidate.recovery as string)) {
    throw new Error("Agent invocation failure receipt is malformed");
  }
  if (progress.workspaceAccess === "write"
    ? candidate.recovery !== "unknown_outcome_no_replay"
    : candidate.recovery !== (progress.providerSessionId === undefined
        ? "none"
        : "explicit_read_only_resume")) {
    throw new Error("Agent invocation failure recovery is inconsistent");
  }
  const failedAt = iso(candidate.failedAt);
  return {
    schemaVersion: "AgentInvocationFailure@1",
    ...progress,
    failedAt,
    reason: candidate.reason as AgentInvocationFailure["reason"],
    ...(candidate.totalTimeoutMilliseconds === undefined
      ? {}
      : { totalTimeoutMilliseconds: candidate.totalTimeoutMilliseconds as number }),
    meaningfulOutputTimeoutMilliseconds:
      candidate.meaningfulOutputTimeoutMilliseconds as number,
    protocolStop: candidate.protocolStop as AgentInvocationFailure["protocolStop"],
    recovery: candidate.recovery as AgentInvocationFailure["recovery"]
  };
}

function invocationTraceCandidate(
  value: string | null,
  schema: string
): Readonly<Record<string, unknown>> | undefined {
  if (value === null) return undefined;
  const receipt = parseJsonObject(value, "Execution receipt");
  if (receipt.schema !== schema) return undefined;
  if (!isRecord(receipt.trace)) throw new Error("Agent invocation trace receipt is malformed");
  return receipt.trace;
}

function normalizedAgentInvocationProgress(
  candidate: Readonly<Record<string, unknown>>
): Omit<AgentInvocationProgress, "schemaVersion"> {
  if (typeof candidate.adapterId !== "string" || candidate.adapterId.trim() === "" ||
    typeof candidate.workspace !== "string" || candidate.workspace.trim() === "" ||
    (candidate.workspaceAccess !== "read" && candidate.workspaceAccess !== "write") ||
    (candidate.providerSessionId !== undefined &&
      (typeof candidate.providerSessionId !== "string" ||
        candidate.providerSessionId.trim() === "")) ||
    typeof candidate.startedAt !== "string" || typeof candidate.observedAt !== "string" ||
    typeof candidate.lastMeaningfulAt !== "string" ||
    !["starting", "session_ready", "prompting", "streaming", "cancelling", "terminated"]
      .includes(candidate.phase as string) ||
    !validBoundedInteger(candidate.updateCount, 0, Number.MAX_SAFE_INTEGER) ||
    !validBoundedInteger(candidate.meaningfulUpdateCount, 0, Number.MAX_SAFE_INTEGER)) {
    throw new Error("Agent invocation progress receipt is malformed");
  }
  if (candidate.lastProgress !== undefined && (!isRecord(candidate.lastProgress) ||
    !["session", "assistant", "thought", "tool", "plan", "protocol"]
      .includes(candidate.lastProgress.kind as string))) {
    throw new Error("Agent invocation progress receipt is malformed");
  }
  if ((candidate.meaningfulUpdateCount as number) > (candidate.updateCount as number)) {
    throw new Error("Agent invocation progress counters are inconsistent");
  }
  const startedAt = iso(candidate.startedAt as string);
  const observedAt = iso(candidate.observedAt as string);
  const lastMeaningfulAt = iso(candidate.lastMeaningfulAt as string);
  return {
    adapterId: candidate.adapterId as string,
    workspace: candidate.workspace as string,
    workspaceAccess: candidate.workspaceAccess as "read" | "write",
    ...(candidate.providerSessionId === undefined
      ? {}
      : { providerSessionId: candidate.providerSessionId as string }),
    startedAt,
    observedAt,
    lastMeaningfulAt,
    phase: candidate.phase as AgentInvocationProgress["phase"],
    updateCount: candidate.updateCount as number,
    meaningfulUpdateCount: candidate.meaningfulUpdateCount as number,
    ...(candidate.lastProgress === undefined
      ? {}
      : {
          lastProgress: {
            kind: candidate.lastProgress.kind as NonNullable<
              AgentInvocationProgress["lastProgress"]
            >["kind"]
          }
        })
  };
}

function validBoundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= minimum && value <= maximum;
}

function validOptionalNumbers(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[]
): boolean {
  return fields.every((field) => record[field] === undefined ||
    (typeof record[field] === "number" &&
      Number.isFinite(record[field]) && (record[field] as number) >= 0));
}

export function parseDestinationSnapshots(
  value: string,
  eventId: string
): DestinationSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Event Destination snapshots are malformed: ${eventId}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Event Destination snapshots are malformed: ${eventId}`);
  }
  return parsed.map((entry) => {
    if (!isRecord(entry) ||
      typeof entry.destinationId !== "string" ||
      (entry.kind !== "matrix" && entry.kind !== "macos-notification" &&
        entry.kind !== "server-topic" && entry.kind !== "vikunja-task" && entry.kind !== "codex-desktop") ||
      !isStringRecord(entry.address) ||
      typeof entry.createdAt !== "string" ||
      typeof entry.updatedAt !== "string") {
      throw new Error(`Event Destination snapshot is malformed: ${eventId}`);
    }
    return {
      destinationId: entry.destinationId,
      kind: entry.kind,
      address: entry.address,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  });
}

function parseJsonObject(value: string, field: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${field} must be a JSON object`);
  return parsed;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function iso(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error("timestamp must be ISO-8601");
  return new Date(timestamp).toISOString();
}

export function requireText(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

export function bounded(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
