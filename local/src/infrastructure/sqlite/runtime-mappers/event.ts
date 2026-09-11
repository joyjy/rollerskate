import {
  parseConversationIntentSnapshot,
  parseChatProfileContext,
  type ChatProfileContext
} from "../../../core/chat/model.js";
import {
  parseChatMessageTargets,
  parseChatRunProposalDecision,
  type AgentResultEvent,
  type ChatDispatchEvent,
  type Event
} from "../../../core/event/model.js";

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
  if (row.type === "chat.activation") {
    const payload = chatPayload(row);
    const candidates = payload.candidateAgentIds;
    if (!Array.isArray(candidates) ||
      candidates.some((candidate) => typeof candidate !== "string")) {
      throw new Error(`Chat activation candidates are malformed: ${row.event_id}`);
    }
    const reason = payload.reason;
    const strategyId = payload.strategyId;
    if ((reason !== "topic_opened" && reason !== "manual" && reason !== "scheduled" &&
      reason !== "participant_message" && reason !== "resumed" && reason !== "work_result") ||
      (strategyId !== "starter" && strategyId !== "manual" &&
        strategyId !== "scheduled" && strategyId !== "participant-message" && strategyId !== "work-result") ||
      !Number.isInteger(payload.strategyRevision) ||
      !Number.isInteger(payload.contextRevision) ||
      !Number.isInteger(payload.turnBudget)) {
      throw new Error(`Chat activation is malformed: ${row.event_id}`);
    }
    return {
      ...common,
      type: "chat.activation",
      topicId: requirePayloadText(payload.topicId, row.event_id, "topicId"),
      reason,
      strategyId,
      strategyRevision: payload.strategyRevision as number,
      contextRevision: payload.contextRevision as number,
      conversationIntent: parseConversationIntentSnapshot(
        payload.conversationIntent ?? {
          schema: "ConversationIntentSnapshot@1",
          mode: "continue_recent",
          governanceRevision: payload.contextRevision
        }
      ),
      candidateAgentIds: candidates as string[],
      ...(payload.sequentialDispatch === true ? { sequentialDispatch: true } : {}),
      ...(typeof payload.sourceEventId === "string"
        ? { sourceEventId: payload.sourceEventId }
        : {}),
      turnBudget: payload.turnBudget as number,
      expiresAt: requirePayloadText(payload.expiresAt, row.event_id, "expiresAt")
    };
  }
  if (row.type === "chat.message") {
    const payload = chatPayload(row);
    const sender = payload.sender;
    if (!isRecord(sender) ||
      (sender.kind !== "owner" && sender.kind !== "agent" && sender.kind !== "system") ||
      typeof sender.handleSnapshot !== "string") {
      throw new Error(`Chat message sender is malformed: ${row.event_id}`);
    }
    const targets = parseChatMessageTargets(payload, row.event_id);
    const runProposalDecision = parseChatRunProposalDecision(
      payload.runProposalDecision,
      row.event_id
    );
    const replyToEventId = payload.replyToEventId;
    if (replyToEventId !== undefined && typeof replyToEventId !== "string") {
      throw new Error(`Chat message reply reference is malformed: ${row.event_id}`);
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
    const conversation = payload.conversation;
    if (conversation !== undefined && (!isRecord(conversation) ||
      (conversation.strategyId !== "human-message" &&
        conversation.strategyId !== "participant-message") ||
      !Number.isInteger(conversation.turnBudget) ||
      (conversation.turnBudget as number) < 1 ||
      (conversation.turnBudget as number) > 64)) {
      throw new Error(`Chat conversation budget is malformed: ${row.event_id}`);
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
      ...(replyToEventId === undefined ? {} : { replyToEventId }),
      ...(conversation === undefined
        ? {}
        : {
            conversation: {
              strategyId: conversation.strategyId as "human-message" | "participant-message",
              turnBudget: conversation.turnBudget as number
            }
          }),
      ...(targets === undefined ? {} : { targets }),
      ...(runProposalDecision === undefined ? {} : { runProposalDecision }),
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
    const topicId = requirePayloadText(payload.topicId, row.event_id, "topicId");
    const profileContext: ChatProfileContext | undefined = payload.profileContext === undefined
      ? undefined
      : parseChatProfileContext(
          payload.profileContext,
          row.agent_id,
          topicId,
          row.created_at
        );
    const legacyMessageSource = typeof payload.sourceMessageEventId === "string"
      ? payload.sourceMessageEventId
      : undefined;
    const admissionSnapshot = payload.admissionSnapshot === undefined
      ? undefined
      : parseChatAdmissionSnapshot(payload.admissionSnapshot, row.event_id);
    return {
      ...common,
      type: "chat.dispatch",
      agentId: row.agent_id,
      topicId,
      sourceAttentionEventId: requirePayloadText(
        payload.sourceAttentionEventId ?? legacyMessageSource,
        row.event_id,
        "sourceAttentionEventId"
      ),
      ...(legacyMessageSource === undefined
        ? {}
        : { sourceMessageEventId: legacyMessageSource }),
      targetHandleSnapshot: requirePayloadText(
        payload.targetHandleSnapshot,
        row.event_id,
        "targetHandleSnapshot"
      ),
      promptResourceId: typeof payload.promptResourceId === "string"
        ? payload.promptResourceId
        : "prompt.chat.legacy",
      prompt: row.prompt,
      ...(admissionSnapshot === undefined ? {} : { admissionSnapshot }),
      ...(profileContext === undefined ? {} : { profileContext })
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
    const payload = row.payload_json === null ? undefined : eventPayload(row);
    const wrapped = payload?.schemaVersion === "SubscriptionFirePayload@1";
    const observation = wrapped ? payload.observation : payload;
    if (observation !== undefined && !isRecord(observation)) {
      throw new Error(`Subscription observation is malformed: ${row.event_id}`);
    }
    return {
      ...common,
      type: "subscription.fire",
      agentId: row.agent_id,
      prompt: row.prompt,
      ...(observation === undefined
        ? {}
        : { observation: subscriptionObservationValue(observation, row.event_id) }),
      ...(!wrapped || payload.invocation === undefined
        ? {}
        : { invocation: subscriptionInvocation(payload.invocation, row.event_id) })
    };
  }
  if (row.prompt === null) throw new Error(`Input Event has no prompt: ${row.event_id}`);
  const invocationPayload = row.payload_json === null
    ? undefined
    : eventPayload(row);
  return {
    ...common,
    type: row.type,
    agentId: row.agent_id!,
    prompt: row.prompt,
    ...(invocationPayload === undefined
      ? {}
      : { runContext: agentRunContext(invocationPayload, row.event_id) })
  };
}

function parseChatAdmissionSnapshot(
  value: unknown,
  eventId: string
): ChatDispatchEvent["admissionSnapshot"] {
  if (!isRecord(value) || !Number.isInteger(value.revision) ||
    (value.revision as number) < 1 || !Number.isInteger(value.participantRevision) ||
    (value.participantRevision as number) < 1) {
    throw new Error(`Chat dispatch admission snapshot is malformed: ${eventId}`);
  }
  return {
    revision: value.revision as number,
    participantRevision: value.participantRevision as number
  };
}

function subscriptionObservationValue(
  value: Readonly<Record<string, unknown>>,
  eventId: string
): import("../../../core/event/model.js").SubscriptionFireObservation {
  const facts = value.facts;
  if (!isRecord(facts)) throw new Error(`Subscription facts are malformed: ${eventId}`);
  return {
    version: requirePayloadText(value.version, eventId, "observation.version"),
    facts,
    terminal: payloadOneOf(
      value.terminal,
      ["success", "failure", "cancelled"] as const,
      eventId,
      "observation.terminal"
    ),
    ...(value.terminalKey === undefined
      ? {}
      : { terminalKey: requirePayloadText(value.terminalKey, eventId, "observation.terminalKey") }),
    ...(value.summary === undefined
      ? {}
      : { summary: requirePayloadText(value.summary, eventId, "observation.summary") })
  };
}

function subscriptionInvocation(
  value: unknown,
  eventId: string
): import("../../../core/event/model.js").SubscriptionAgentInvocation {
  if (!isRecord(value) || value.schemaVersion !== "SubscriptionAgentInvocation@1" ||
    value.resultSchema !== "SubscriptionAgentResult@1" ||
    typeof value.networkAccess !== "boolean" || !isRecord(value.workspaceGrant)) {
    throw new Error(`Subscription Agent invocation is malformed: ${eventId}`);
  }
  return {
    schemaVersion: "SubscriptionAgentInvocation@1",
    resultSchema: "SubscriptionAgentResult@1",
    networkAccess: value.networkAccess,
    workspaceGrant: externalWorkspaceGrant(value.workspaceGrant, eventId)
  };
}

function agentRunContext(
  value: Readonly<Record<string, unknown>>,
  eventId: string
): import("../../../core/runtime/model.js").AgentRunContext {
  if (value.schemaVersion !== "AgentRunContext@1") {
    throw new Error(`Agent Run context schema is unsupported: ${eventId}`);
  }
  const completionBinding = value.completionBinding;
  const stepCompletion = value.stepCompletion;
  const workspaceGrant = value.workspaceGrant;
  return {
    schemaVersion: "AgentRunContext@1",
    resultContractId: requirePayloadText(
      value.resultContractId,
      eventId,
      "resultContractId"
    ),
    runId: requirePayloadText(value.runId, eventId, "runId"),
    ...(value.cycleId === undefined
      ? {}
      : { cycleId: requirePayloadText(value.cycleId, eventId, "cycleId") }),
    stepId: requirePayloadText(value.stepId, eventId, "stepId"),
    depth: payloadInteger(value.depth, eventId, "depth", 0),
    ...(value.parentStepId === undefined
      ? {}
      : {
          parentStepId: requirePayloadText(
            value.parentStepId,
            eventId,
            "parentStepId"
          )
        }),
    ...(workspaceGrant === undefined
      ? {}
      : { workspaceGrant: externalWorkspaceGrant(workspaceGrant, eventId) }),
    ...(completionBinding === undefined
      ? {}
      : { completionBinding: completion(completionBinding, eventId) }),
    ...(stepCompletion === undefined
      ? {}
      : { stepCompletion: stepCompletionValue(stepCompletion, eventId) })
  };
}

function externalWorkspaceGrant(
  value: unknown,
  eventId: string
): import("../../../core/runtime/model.js").ExternalWorkspaceGrant {
  if (!isRecord(value) || value.schemaVersion !== "ExternalWorkspaceGrant@1") {
    throw new Error(`External workspace grant is malformed: ${eventId}`);
  }
  const access = payloadOneOf(
    value.access,
    ["read", "write"] as const,
    eventId,
    "workspaceGrant.access"
  );
  const effect = value.effect === undefined
    ? undefined
    : payloadOneOf(
        value.effect,
        ["must_change", "may_remain_unchanged"] as const,
        eventId,
        "workspaceGrant.effect"
      );
  const networkAccess = value.networkAccess === undefined
    ? undefined
    : payloadBoolean(
        value.networkAccess,
        eventId,
        "workspaceGrant.networkAccess"
      );
  if (effect !== undefined && access !== "write") {
    throw new Error(`External workspace grant effect requires write access: ${eventId}`);
  }
  return {
    schemaVersion: "ExternalWorkspaceGrant@1",
    root: requirePayloadText(value.root, eventId, "workspaceGrant.root"),
    access,
    ...(effect === undefined ? {} : { effect }),
    ...(networkAccess === undefined ? {} : { networkAccess }),
    revision: requirePayloadText(
      value.revision,
      eventId,
      "workspaceGrant.revision"
    )
  };
}

function completion(
  value: unknown,
  eventId: string
): import("../../../core/runtime/model.js").AgentCompletionBinding {
  if (!isRecord(value) || value.schemaVersion !== "AgentCompletionBinding@1") {
    throw new Error(`Agent completion binding is malformed: ${eventId}`);
  }
  return {
    schemaVersion: "AgentCompletionBinding@1",
    callerAgentId: requirePayloadText(
      value.callerAgentId,
      eventId,
      "completionBinding.callerAgentId"
    ),
    callerSessionId: requirePayloadText(
      value.callerSessionId,
      eventId,
      "completionBinding.callerSessionId"
    ),
    callerStepId: requirePayloadText(
      value.callerStepId,
      eventId,
      "completionBinding.callerStepId"
    ),
    callerRequestEventId: requirePayloadText(
      value.callerRequestEventId,
      eventId,
      "completionBinding.callerRequestEventId"
    )
  };
}

function stepCompletionValue(
  value: unknown,
  eventId: string
): import("../../../core/runtime/model.js").AgentStepCompletion {
  if (!isRecord(value) || value.schemaVersion !== "AgentStepCompletion@1" ||
    !Array.isArray(value.artifactRefs) ||
    value.artifactRefs.some((item) => typeof item !== "string")) {
    throw new Error(`Agent step completion is malformed: ${eventId}`);
  }
  return {
    schemaVersion: "AgentStepCompletion@1",
    childAgentId: requirePayloadText(
      value.childAgentId,
      eventId,
      "stepCompletion.childAgentId"
    ),
    childStepId: requirePayloadText(
      value.childStepId,
      eventId,
      "stepCompletion.childStepId"
    ),
    childRequestEventId: requirePayloadText(
      value.childRequestEventId,
      eventId,
      "stepCompletion.childRequestEventId"
    ),
    childResultEventId: requirePayloadText(
      value.childResultEventId,
      eventId,
      "stepCompletion.childResultEventId"
    ),
    childExecutionId: requirePayloadText(
      value.childExecutionId,
      eventId,
      "stepCompletion.childExecutionId"
    ),
    outcome: payloadOneOf(
      value.outcome,
      ["succeeded", "failed", "needs_human"] as const,
      eventId,
      "stepCompletion.outcome"
    ),
    summary: requirePayloadText(value.summary, eventId, "stepCompletion.summary"),
    artifactRefs: value.artifactRefs as string[],
    ...(value.observedWorkspaceRevision === undefined
      ? {}
      : {
          observedWorkspaceRevision: requirePayloadText(
            value.observedWorkspaceRevision,
            eventId,
            "stepCompletion.observedWorkspaceRevision"
          )
        })
  };
}

function eventPayload(row: EventRow): Readonly<Record<string, unknown>> {
  if (row.payload_json === null) throw new Error(`Event payload is missing: ${row.event_id}`);
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error(`Event payload is malformed: ${row.event_id}`);
  }
  if (!isRecord(value)) throw new Error(`Event payload is not an object: ${row.event_id}`);
  return value;
}

function payloadInteger(
  value: unknown,
  eventId: string,
  field: string,
  minimum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`Event ${field} is malformed: ${eventId}`);
  }
  return value as number;
}

function payloadBoolean(
  value: unknown,
  eventId: string,
  field: string
): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Event ${field} is malformed: ${eventId}`);
  }
  return value;
}

function payloadOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  eventId: string,
  field: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Event ${field} is malformed: ${eventId}`);
  }
  return value;
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
