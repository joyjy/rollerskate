import type {
  AgentInputEvent,
  ChatActivationEvent,
  ChatDispatchEvent,
  ChatMessageEvent
} from "../../core/event/model.js";
import type {
  RuntimeAgentExecutionGuard,
  RuntimeAgentExecutionGuardDecision
} from "../../core/runtime/handlers.js";
import type { RuntimeStore } from "../../core/runtime/store.js";
import type { ChatPresence } from "../../core/chat/model.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import type { TopicGovernance } from "../../modules/topic/governance.js";

export type TopicAttentionSource = ChatActivationEvent | ChatMessageEvent;

export interface TopicAttentionAdmission {
  readonly candidates: readonly LocalAgent[];
  readonly snapshotFor: (
    agentId: string
  ) => ChatDispatchEvent["admissionSnapshot"] | undefined;
}

export class TopicGovernanceAdmissionPolicy implements RuntimeAgentExecutionGuard {
  public readonly moduleId = "topic-governance";
  readonly #getGovernance: (topicId: string) => TopicGovernance | undefined;
  readonly #listAgents: () => readonly LocalAgent[];
  readonly #runtime: Pick<
    RuntimeStore,
    "event" | "chatAttentionReceipts" | "chatPresence"
  >;

  public constructor(options: {
    readonly getGovernance: (topicId: string) => TopicGovernance | undefined;
    readonly listAgents: () => readonly LocalAgent[];
    readonly runtime: Pick<
      RuntimeStore,
      "event" | "chatAttentionReceipts" | "chatPresence"
    >;
  }) {
    this.#getGovernance = options.getGovernance;
    this.#listAgents = options.listAgents;
    this.#runtime = options.runtime;
  }

  public admitAttention(
    source: TopicAttentionSource,
    candidates: readonly LocalAgent[]
  ): TopicAttentionAdmission {
    if (syntheticActivationRejection(source) !== undefined) return skipped();
    const governance = this.#getGovernance(source.topicId);
    if (governance === undefined) return unrestricted(candidates);
    const rejection = governanceRejection(governance, source);
    if (rejection !== undefined) return skipped();
    const activeParticipants = new Map(governance.participants
      .filter(({ status }) => status === "active")
      .map((participant) => [participant.agentId, participant] as const));
    const eligible = candidates.filter((agent) =>
      agent.status === "active" && activeParticipants.has(agent.principalId));
    return {
      candidates: eligible,
      snapshotFor: (agentId) => {
        const participant = activeParticipants.get(agentId);
        return participant === undefined
          ? undefined
          : {
              revision: governance.revision,
              participantRevision: participant.governanceRevision
            };
      }
    };
  }

  public canInvoke(
    event: AgentInputEvent | ChatDispatchEvent,
    at: string
  ): RuntimeAgentExecutionGuardDecision {
    if (event.type !== "chat.dispatch") return { outcome: "allow" };
    const source = this.#runtime.event(event.sourceAttentionEventId);
    if (source?.type !== "chat.activation" && source?.type !== "chat.message") {
      return skipDecision("topic-attention-source-unavailable");
    }
    const syntheticRejection = syntheticActivationRejection(source);
    if (syntheticRejection !== undefined) return skipDecision(syntheticRejection);
    const governance = this.#getGovernance(event.topicId);
    if (governance === undefined) return { outcome: "allow" };
    const rejection = governanceRejection(governance, source);
    if (rejection !== undefined) return skipDecision(rejection);
    const agent = this.#listAgents().find(({ principalId }) => principalId === event.agentId);
    if (agent?.status !== "active") return skipDecision("local-agent-inactive");
    const participant = governance.participants.find(({ agentId }) => agentId === event.agentId);
    if (participant?.status !== "active") return skipDecision("topic-participant-ineligible");
    if (event.admissionSnapshot !== undefined &&
      (event.admissionSnapshot.revision !== governance.revision ||
        event.admissionSnapshot.participantRevision !== participant.governanceRevision)) {
      return skipDecision("topic-governance-revision-changed");
    }
    const receipt = this.#runtime.chatAttentionReceipts(event.sourceAttentionEventId)
      .find(({ dispatchEventId }) => dispatchEventId === event.eventId);
    const presence = this.#runtime.chatPresence(event.agentId, event.topicId);
    if (receipt !== undefined &&
      (newSnooze(presence.global, receipt.presenceSnapshot.global, "global", at) ||
        newSnooze(presence.topic, receipt.presenceSnapshot.topic, "topic", at))) {
      return skipDecision("chat-presence-changed");
    }
    return { outcome: "allow" };
  }
}

export function governanceRejection(
  governance: TopicGovernance,
  source: TopicAttentionSource
): string | undefined {
  if (governance.topicId !== source.topicId) {
    throw new Error(`Topic governance does not own attention source: ${source.topicId}`);
  }
  if (governance.status === "paused") return "topic-paused";
  if (source.type === "chat.activation") {
    const retired = syntheticActivationRejection(source);
    if (retired !== undefined) return retired;
    if (source.contextRevision !== governance.revision) {
      return "topic-governance-revision-changed";
    }
    if (source.strategyId === "scheduled" && !governance.strategyPolicy.scheduledEnabled) {
      return "topic-scheduled-disabled";
    }
    if (source.strategyId === "participant-message" &&
      !governance.strategyPolicy.participantMessageEnabled) {
      return "topic-participant-message-disabled";
    }
  }
  if (source.type === "chat.message" && source.sender.kind === "agent" &&
    !governance.strategyPolicy.participantMessageEnabled) {
    return "topic-participant-message-disabled";
  }
  return undefined;
}

function syntheticActivationRejection(source: TopicAttentionSource): string | undefined {
  return source.type === "chat.activation" &&
    (source.strategyId === "manual" || source.strategyId === "starter")
    ? "topic-synthetic-activation-retired"
    : undefined;
}

function unrestricted(candidates: readonly LocalAgent[]): TopicAttentionAdmission {
  return {
    candidates,
    snapshotFor: () => undefined
  };
}

function skipped(): TopicAttentionAdmission {
  return {
    candidates: [],
    snapshotFor: () => undefined
  };
}

function skipDecision(reason: string): RuntimeAgentExecutionGuardDecision {
  return { outcome: "skip", reason };
}

function newSnooze(
  current: ChatPresence | undefined,
  admitted: ChatPresence,
  scope: ChatPresence["scope"],
  at: string
): boolean {
  const effective = effectivePresence(current, scope, at);
  return effective.mode === "snoozed" && !samePresence(effective, admitted);
}

function effectivePresence(
  presence: ChatPresence | undefined,
  scope: ChatPresence["scope"],
  at: string
): ChatPresence {
  const now = Date.parse(at);
  if (Number.isNaN(now)) throw new Error("guard time must be ISO-8601");
  if (presence === undefined || presence.mode === "available" ||
    presence.until === undefined || Date.parse(presence.until) <= now) {
    return { scope, mode: "available", wakeKeywords: [] };
  }
  return presence;
}

function samePresence(left: ChatPresence, right: ChatPresence): boolean {
  return left.scope === right.scope && left.mode === right.mode &&
    left.until === right.until &&
    left.wakeKeywords.length === right.wakeKeywords.length &&
    left.wakeKeywords.every((keyword, index) => keyword === right.wakeKeywords[index]);
}
