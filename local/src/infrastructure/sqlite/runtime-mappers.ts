import type {
  ChatPresence,
  ChatTurnDecision
} from "../../core/chat/model.js";
import type {
  ChatAttentionPlan,
  ChatAttentionReason
} from "../../core/chat/state-machine.js";
import {
  requireEventId,
  type AgentResultEvent,
  type Event
} from "../../core/event/model.js";
import type {
  RuntimeDelivery,
  RuntimeDestination,
  RuntimeExecution,
  RuntimeHandlerKind,
  RuntimeSession
} from "../../core/runtime/model.js";

export interface EventRow {
  event_id: string;
  type: Event["type"];
  source_kind: Event["source"]["kind"];
  source_external_id: string | null;
  agent_id: string | null;
  prompt: string | null;
  outcome: AgentResultEvent["outcome"] | null;
  output: string | null;
  error: string | null;
  payload_json: string | null;
  session_id: string | null;
  destination_ids_json: string;
  destination_snapshots_json: string;
  root_event_id: string;
  parent_event_id: string | null;
  causal_hop: number;
  created_at: string;
}

export interface ExecutionRow {
  execution_id: string;
  event_id: string;
  handler: RuntimeHandlerKind;
  status: RuntimeExecution["status"];
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  receipt_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface SessionRow {
  session_id: string;
  agent_id: string;
  adapter_id: string;
  provider_session_id: string;
  workspace: string;
  created_at: string;
  updated_at: string;
}

export interface DestinationRow {
  destination_id: string;
  kind: RuntimeDestination["kind"];
  address_json: string;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  delivery_id: string;
  result_event_id: string;
  destination_id: string;
  destination_kind: RuntimeDestination["kind"];
  destination_address_json: string;
  status: RuntimeDelivery["status"];
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  receipt: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatPresenceRow {
  agent_id: string;
  scope_kind: ChatPresence["scope"];
  scope_id: string;
  mode: ChatPresence["mode"];
  until_at: string | null;
  wake_keywords_json: string;
  revision: number;
  updated_by_dispatch_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatAttentionReceiptRow {
  source_message_event_id: string;
  agent_id: string;
  outcome: "dispatched" | "skipped";
  reason: ChatAttentionReason;
  presence_snapshot_json: string;
  dispatch_event_id: string | null;
  prompt_resource_id: string | null;
  created_at: string;
}

export interface ChatDecisionReceiptRow {
  dispatch_event_id: string;
  speech_action: ChatTurnDecision["speech"]["action"];
  presence_transition_json: string;
  reply_event_id: string | null;
  created_at: string;
}

export interface ChatAttentionReceipt {
  readonly sourceMessageEventId: string;
  readonly agentId: string;
  readonly outcome: "dispatched" | "skipped";
  readonly reason: ChatAttentionReason;
  readonly presenceSnapshot: ChatAttentionPlan["presenceSnapshot"];
  readonly dispatchEventId?: string;
  readonly promptResourceId?: string;
  readonly createdAt: string;
}

export interface ChatDecisionReceipt {
  readonly dispatchEventId: string;
  readonly speechAction: ChatTurnDecision["speech"]["action"];
  readonly presenceTransition?: ChatPresence;
  readonly replyEventId?: string;
  readonly createdAt: string;
}

export function mapEvent(row: EventRow): Event {
  const destinations = JSON.parse(row.destination_ids_json) as unknown;
  if (!Array.isArray(destinations) || destinations.some((destination) => typeof destination !== "string")) {
    throw new Error(`Event destination IDs are malformed: ${row.event_id}`);
  }
  const common = {
    eventId: row.event_id,
    source: {
      kind: row.source_kind,
      ...(row.source_external_id === null ? {} : { externalId: row.source_external_id })
    },
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    destinationIds: destinations as string[],
    causality: {
      rootEventId: row.root_event_id,
      ...(row.parent_event_id === null ? {} : { parentEventId: row.parent_event_id }),
      hop: row.causal_hop
    },
    createdAt: row.created_at
  };
  if (row.type === "chat.message") {
    const payload = chatPayload(row);
    const sender = payload.sender;
    if (!isRecord(sender) ||
      (sender.kind !== "owner" && sender.kind !== "agent" && sender.kind !== "system") ||
      typeof sender.handleSnapshot !== "string") {
      throw new Error(`Chat message sender is malformed: ${row.event_id}`);
    }
    const target = payload.target;
    if (target !== undefined && (!isRecord(target) ||
      typeof target.principalId !== "string" ||
      typeof target.handleSnapshot !== "string")) {
      throw new Error(`Chat message target is malformed: ${row.event_id}`);
    }
    const dispatchCard = payload.dispatchCard;
    if (dispatchCard !== undefined && (!isRecord(dispatchCard) ||
      typeof dispatchCard.sourceMessageEventId !== "string" ||
      !Array.isArray(dispatchCard.candidates) ||
      dispatchCard.candidates.some((candidate) => !isRecord(candidate) ||
        typeof candidate.principalId !== "string" ||
        typeof candidate.handle !== "string"))) {
      throw new Error(`Chat dispatch card is malformed: ${row.event_id}`);
    }
    return {
      ...common,
      type: "chat.message",
      topicId: requirePayloadText(payload.topicId, row.event_id, "topicId"),
      sender: {
        kind: sender.kind,
        ...(typeof sender.principalId === "string"
          ? { principalId: sender.principalId }
          : {}),
        handleSnapshot: sender.handleSnapshot
      },
      body: requirePayloadText(payload.body, row.event_id, "body"),
      ...(target === undefined
        ? {}
        : {
            target: {
              principalId: target.principalId as string,
              handleSnapshot: target.handleSnapshot as string
            }
          }),
      ...(dispatchCard === undefined
        ? {}
        : {
            dispatchCard: {
              sourceMessageEventId: dispatchCard.sourceMessageEventId as string,
              candidates: (dispatchCard.candidates as Array<{
                principalId: string;
                handle: string;
              }>).map(({ principalId, handle }) => ({ principalId, handle }))
            }
          })
    };
  }
  if (row.type === "chat.dispatch") {
    if (row.agent_id === null || row.prompt === null) {
      throw new Error(`Chat dispatch is missing Agent input: ${row.event_id}`);
    }
    const payload = chatPayload(row);
    return {
      ...common,
      type: "chat.dispatch",
      agentId: row.agent_id,
      topicId: requirePayloadText(payload.topicId, row.event_id, "topicId"),
      sourceMessageEventId: requirePayloadText(
        payload.sourceMessageEventId,
        row.event_id,
        "sourceMessageEventId"
      ),
      targetHandleSnapshot: requirePayloadText(
        payload.targetHandleSnapshot,
        row.event_id,
        "targetHandleSnapshot"
      ),
      promptResourceId: typeof payload.promptResourceId === "string"
        ? payload.promptResourceId
        : "prompt.chat.legacy",
      prompt: row.prompt
    };
  }
  if (row.type === "agent.result") {
    if (row.outcome === null || row.agent_id === null) {
      throw new Error(`Result Event is incomplete: ${row.event_id}`);
    }
    return {
      ...common,
      type: "agent.result",
      agentId: row.agent_id,
      outcome: row.outcome,
      ...(row.output === null ? {} : { output: row.output }),
      ...(row.error === null ? {} : { error: row.error })
    };
  }
  if (row.type === "subscription.fire") {
    if (row.prompt === null || row.agent_id === null) {
      throw new Error(`Subscription fire is missing Agent input: ${row.event_id}`);
    }
    return {
      ...common,
      type: "subscription.fire",
      agentId: row.agent_id,
      prompt: row.prompt,
      ...(row.payload_json === null
        ? {}
        : { observation: subscriptionObservation(row) })
    };
  }
  if (row.type === "review.requested") {
    const payload = reviewPayload(row);
    return {
      ...common,
      type: "review.requested",
      cycleIndex: payloadInteger(payload.cycleIndex, row.event_id, "cycleIndex", 0),
      subject: reviewSubject(payload.subject, row.event_id),
      artifactRef: requirePayloadText(payload.artifactRef, row.event_id, "artifactRef"),
      ...(payload.artifactRevision === undefined
        ? {}
        : {
            artifactRevision: requirePayloadText(
              payload.artifactRevision,
              row.event_id,
              "artifactRevision"
            )
          }),
      evidence: reviewEvidence(payload.evidence, row.event_id),
      implementationRevision: requirePayloadText(
        payload.implementationRevision,
        row.event_id,
        "implementationRevision"
      ),
      reviewerAgentId: requirePayloadText(
        payload.reviewerAgentId,
        row.event_id,
        "reviewerAgentId"
      ),
      implementerAgentId: requirePayloadText(
        payload.implementerAgentId,
        row.event_id,
        "implementerAgentId"
      ),
      reworkLimit: payloadInteger(payload.reworkLimit, row.event_id, "reworkLimit", 0)
    };
  }
  if (row.type === "review.decision") {
    const payload = reviewPayload(row);
    const revisions = payload.revisionsRead;
    if (!isRecord(revisions)) {
      throw new Error(`Review decision revisionsRead is malformed: ${row.event_id}`);
    }
    return {
      ...common,
      type: "review.decision",
      cycleIndex: payloadInteger(payload.cycleIndex, row.event_id, "cycleIndex", 0),
      requestedEventId: requirePayloadText(
        payload.requestedEventId,
        row.event_id,
        "requestedEventId"
      ),
      reviewerResultEventId: requirePayloadText(
        payload.reviewerResultEventId,
        row.event_id,
        "reviewerResultEventId"
      ),
      decision: payloadOneOf(
        payload.decision,
        ["passed", "findings", "blocked"] as const,
        row.event_id,
        "decision"
      ),
      boundedSummary: requirePayloadText(
        payload.boundedSummary,
        row.event_id,
        "boundedSummary"
      ),
      revisionsRead: {
        subject: requirePayloadText(
          revisions.subject,
          row.event_id,
          "revisionsRead.subject"
        ),
        ...(revisions.artifact === undefined
          ? {}
          : {
              artifact: requirePayloadText(
                revisions.artifact,
                row.event_id,
                "revisionsRead.artifact"
              )
            }),
        evidence: reviewEvidence(revisions.evidence, row.event_id)
      },
      artifactRevision: requirePayloadText(
        payload.artifactRevision,
        row.event_id,
        "artifactRevision"
      ),
      openFindingCount: payloadInteger(
        payload.openFindingCount,
        row.event_id,
        "openFindingCount",
        0
      ),
      ...(payload.blockedReason === undefined
        ? {}
        : {
            blockedReason: requirePayloadText(
              payload.blockedReason,
              row.event_id,
              "blockedReason"
            )
          })
    };
  }
  if (row.prompt === null) throw new Error(`Input Event has no prompt: ${row.event_id}`);
  return {
    ...common,
    type: row.type,
    agentId: row.agent_id!,
    prompt: row.prompt,
    ...(row.payload_json === null
      ? {}
      : { reviewInvocation: reviewInvocation(row) })
  };
}

export function validateReviewInvocation(
  invocation: import("../../core/event/model.js").ReviewAgentInvocation,
  agentId: string
): void {
  if (invocation.schemaVersion !== "review-invocation@1") {
    throw new Error("reviewInvocation schemaVersion must be review-invocation@1");
  }
  if ((invocation.role === "reviewer" && invocation.workspaceAccess !== "read") ||
    (invocation.role === "implementer" && invocation.workspaceAccess !== "write")) {
    throw new Error("reviewInvocation role and workspaceAccess do not match");
  }
  if ((invocation.role === "reviewer" && invocation.resultSchema !== "ReviewerResult@1") ||
    (invocation.role === "implementer" &&
      invocation.resultSchema !== "ImplementerResult@1")) {
    throw new Error("reviewInvocation role and resultSchema do not match");
  }
  requireText(agentId, "agentId");
  requireEventId(invocation.rootEventId, "reviewInvocation.rootEventId");
  bounded(invocation.cycleIndex, 0, 1_000, "reviewInvocation.cycleIndex");
  requireText(invocation.subject.ref, "reviewInvocation.subject.ref");
  requireText(invocation.subject.revision, "reviewInvocation.subject.revision");
  requireText(invocation.artifactRef, "reviewInvocation.artifactRef");
  requireText(invocation.implementationRevision, "reviewInvocation.implementationRevision");
  if (invocation.workspaceAccess === "write") {
    requireText(invocation.writableRoot ?? "", "reviewInvocation.writableRoot");
  } else if (invocation.writableRoot !== undefined) {
    throw new Error("read-only reviewInvocation must not define writableRoot");
  }
}

function reviewInvocation(
  row: EventRow
): import("../../core/event/model.js").ReviewAgentInvocation {
  const payload = reviewPayload(row);
  const role = payloadOneOf(
    payload.role,
    ["reviewer", "implementer"] as const,
    row.event_id,
    "role"
  );
  const workspaceAccess = payloadOneOf(
    payload.workspaceAccess,
    ["read", "write"] as const,
    row.event_id,
    "workspaceAccess"
  );
  const resultSchema = payloadOneOf(
    payload.resultSchema,
    ["ReviewerResult@1", "ImplementerResult@1"] as const,
    row.event_id,
    "resultSchema"
  );
  if (payload.schemaVersion !== "review-invocation@1") {
    throw new Error(`Review invocation schema is unsupported: ${row.event_id}`);
  }
  const invocation: import("../../core/event/model.js").ReviewAgentInvocation = {
    schemaVersion: "review-invocation@1",
    role,
    rootEventId: requirePayloadText(payload.rootEventId, row.event_id, "rootEventId"),
    cycleIndex: payloadInteger(payload.cycleIndex, row.event_id, "cycleIndex", 0),
    subject: reviewSubject(payload.subject, row.event_id),
    artifactRef: requirePayloadText(payload.artifactRef, row.event_id, "artifactRef"),
    ...(payload.artifactRevision === undefined
      ? {}
      : {
          artifactRevision: requirePayloadText(
            payload.artifactRevision,
            row.event_id,
            "artifactRevision"
          )
        }),
    evidence: reviewEvidence(payload.evidence, row.event_id),
    implementationRevision: requirePayloadText(
      payload.implementationRevision,
      row.event_id,
      "implementationRevision"
    ),
    workspaceAccess,
    ...(payload.writableRoot === undefined
      ? {}
      : {
          writableRoot: requirePayloadText(
            payload.writableRoot,
            row.event_id,
            "writableRoot"
          )
        }),
    resultSchema
  };
  validateReviewInvocation(invocation, row.agent_id ?? "");
  return invocation;
}

function reviewSubject(
  value: unknown,
  eventId: string
): import("../../core/event/model.js").ReviewReference {
  if (!isRecord(value) || value.kind !== "acceptance") {
    throw new Error(`Review subject is malformed: ${eventId}`);
  }
  return {
    kind: "acceptance",
    ref: requirePayloadText(value.ref, eventId, "subject.ref"),
    revision: requirePayloadText(value.revision, eventId, "subject.revision")
  };
}

function reviewEvidence(
  value: unknown,
  eventId: string
): import("../../core/event/model.js").ReviewEvidenceReference[] {
  if (!Array.isArray(value)) throw new Error(`Review evidence is malformed: ${eventId}`);
  return value.map((entry) => {
    if (!isRecord(entry) || entry.kind !== "workspace") {
      throw new Error(`Review evidence is malformed: ${eventId}`);
    }
    return {
      kind: "workspace",
      ref: requirePayloadText(entry.ref, eventId, "evidence.ref"),
      revision: requirePayloadText(entry.revision, eventId, "evidence.revision")
    };
  });
}

function reviewPayload(row: EventRow): Readonly<Record<string, unknown>> {
  if (row.payload_json === null) throw new Error(`Review Event payload is missing: ${row.event_id}`);
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error(`Review Event payload is malformed: ${row.event_id}`);
  }
  if (!isRecord(value)) throw new Error(`Review Event payload is not an object: ${row.event_id}`);
  return value;
}

function payloadInteger(
  value: unknown,
  eventId: string,
  field: string,
  minimum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`Review Event ${field} is malformed: ${eventId}`);
  }
  return value as number;
}

function payloadOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  eventId: string,
  field: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Review Event ${field} is malformed: ${eventId}`);
  }
  return value;
}

function subscriptionObservation(
  row: EventRow
): import("../../core/event/model.js").SubscriptionFireObservation {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json!) as unknown;
  } catch {
    throw new Error(`Subscription fire observation is malformed: ${row.event_id}`);
  }
  if (!isRecord(value) || typeof value.version !== "string" ||
    !isRecord(value.facts) ||
    (value.terminal !== "success" && value.terminal !== "failure" &&
      value.terminal !== "cancelled") ||
    (value.summary !== undefined && typeof value.summary !== "string")) {
    throw new Error(`Subscription fire observation is malformed: ${row.event_id}`);
  }
  return {
    version: value.version,
    facts: value.facts,
    terminal: value.terminal,
    ...(value.summary === undefined ? {} : { summary: value.summary })
  };
}

function chatPayload(row: EventRow): Readonly<Record<string, unknown>> {
  if (row.payload_json === null) {
    throw new Error(`Chat Event payload is missing: ${row.event_id}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error(`Chat Event payload is malformed: ${row.event_id}`);
  }
  if (!isRecord(value)) throw new Error(`Chat Event payload is not an object: ${row.event_id}`);
  return value;
}

export function mapChatPresence(row: ChatPresenceRow): ChatPresence {
  const wakeKeywords = JSON.parse(row.wake_keywords_json) as unknown;
  if (!Array.isArray(wakeKeywords) ||
    wakeKeywords.some((keyword) => typeof keyword !== "string")) {
    throw new Error(`Chat presence wake keywords are malformed: ${row.agent_id}`);
  }
  return {
    scope: row.scope_kind,
    mode: row.mode,
    ...(row.until_at === null ? {} : { until: row.until_at }),
    wakeKeywords
  };
}

export function mapChatAttentionReceipt(row: ChatAttentionReceiptRow): ChatAttentionReceipt {
  const snapshot = JSON.parse(row.presence_snapshot_json) as
    ChatAttentionPlan["presenceSnapshot"];
  return {
    sourceMessageEventId: row.source_message_event_id,
    agentId: row.agent_id,
    outcome: row.outcome,
    reason: row.reason,
    presenceSnapshot: snapshot,
    ...(row.dispatch_event_id === null ? {} : { dispatchEventId: row.dispatch_event_id }),
    ...(row.prompt_resource_id === null ? {} : { promptResourceId: row.prompt_resource_id }),
    createdAt: row.created_at
  };
}

export function mapChatDecisionReceipt(row: ChatDecisionReceiptRow): ChatDecisionReceipt {
  const presence = JSON.parse(row.presence_transition_json) as ChatPresence | null;
  return {
    dispatchEventId: row.dispatch_event_id,
    speechAction: row.speech_action,
    ...(presence === null ? {} : { presenceTransition: presence }),
    ...(row.reply_event_id === null ? {} : { replyEventId: row.reply_event_id }),
    createdAt: row.created_at
  };
}

function requirePayloadText(
  value: unknown,
  eventId: string,
  field: string
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Chat Event ${field} is malformed: ${eventId}`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapExecution(row: ExecutionRow): RuntimeExecution {
  return {
    executionId: row.execution_id,
    eventId: row.event_id,
    handler: row.handler,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at
  };
}

export function mapSession(row: SessionRow): RuntimeSession {
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    adapterId: row.adapter_id,
    providerSessionId: row.provider_session_id,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapDestination(row: DestinationRow): RuntimeDestination {
  return {
    destinationId: row.destination_id,
    kind: row.kind,
    address: JSON.parse(row.address_json) as Readonly<Record<string, string>>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapDelivery(row: DeliveryRow): RuntimeDelivery {
  return {
    deliveryId: row.delivery_id,
    resultEventId: row.result_event_id,
    destinationId: row.destination_id,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.receipt === null ? {} : { receipt: row.receipt }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireText(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
