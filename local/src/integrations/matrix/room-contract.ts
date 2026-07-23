import type { RoomEventPage, RoomEventProjection, RoomHead } from "@rollerskate/protocol";

export type OwnerMessageWake = "never" | "mention_only" | "normal";
export type RoomWakeMode = "disabled" | "mention_only" | "proactive";

export interface RoomChatPolicy {
  readonly wakeMode: RoomWakeMode;
  readonly ownerMessageWake: OwnerMessageWake;
  readonly intervalMilliseconds: number;
  readonly minUnread: number;
  readonly quietWindow?: { readonly startHour: number; readonly endHour: number };
  readonly maxWakesPerHour: number;
  readonly maxRepliesPerHour: number;
  readonly maxInputTokensPerTurn: number;
  readonly maxOutputTokensPerTurn: number;
  readonly maxDailyTokens: number;
  readonly maxContextEvents: number;
  readonly maxHistoryPages: number;
  readonly inboxTtlMilliseconds: number;
  readonly maxAgentReplyHops: number;
}

export const DEFAULT_ROOM_CHAT_POLICY: RoomChatPolicy = {
  wakeMode: "mention_only",
  ownerMessageWake: "mention_only",
  intervalMilliseconds: 0,
  minUnread: 1,
  maxWakesPerHour: 12,
  maxRepliesPerHour: 12,
  maxInputTokensPerTurn: 32_000,
  maxOutputTokensPerTurn: 4_000,
  maxDailyTokens: 500_000,
  maxContextEvents: 50,
  maxHistoryPages: 3,
  inboxTtlMilliseconds: 24 * 60 * 60 * 1_000,
  maxAgentReplyHops: 8
};

export interface RoomChatBinding {
  readonly bindingId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentMxid?: string;
  readonly credentialId?: string;
  readonly placementId?: string;
  readonly roomId: string;
  readonly ownerHumanId: string;
  readonly operatorHumanId: string;
  readonly policy: RoomChatPolicy;
}

export type ChatAction =
  | { readonly type: "reply"; readonly body: string }
  | { readonly type: "silent"; readonly reason?: string }
  | { readonly type: "request_history"; readonly before?: string; readonly limit: number }
  | { readonly type: "compact"; readonly summary: string };

export interface ChatAgentRequest {
  readonly turnId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly sessionId?: string;
  readonly durableSummary?: string;
  readonly events: readonly RoomEventProjection[];
  readonly history: readonly RoomEventProjection[];
  readonly historyTruncated: boolean;
  readonly causalChainId: string;
  readonly causalHop: number;
  readonly continuation?: {
    readonly subscriptionId: string;
    readonly prompt: string;
    readonly terminal: "success" | "failure" | "cancelled";
    readonly facts: Readonly<Record<string, unknown>>;
  };
}

export interface ChatAgentReceipt {
  readonly action: ChatAction;
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cumulativeInputTokens?: number;
  readonly cumulativeOutputTokens?: number;
}

export interface RoomChatAgent {
  readonly adapterId: string;
  invoke(request: ChatAgentRequest): Promise<ChatAgentReceipt>;
}

export interface RoomHistorySource {
  head(roomId: string): Promise<RoomHead>;
  events(input: {
    readonly roomId: string;
    readonly after?: string;
    readonly through: string;
    readonly limit: number;
  }): Promise<RoomEventPage>;
}

export interface RoomMessagePublisher {
  send(input: {
    readonly agentId: string;
    readonly roomId: string;
    readonly transactionId: string;
    readonly body: string;
    readonly causalChainId: string;
    readonly causalHop: number;
  }): Promise<{ readonly eventId: string }>;
}

export interface RoomChatCycleResult {
  readonly roomId: string;
  readonly readThrough: string;
  readonly syncedEvents: number;
  readonly turns: readonly RoomChatTurnResult[];
  readonly deliveries: readonly RoomChatDeliveryResult[];
}

export interface RoomChatTurnResult {
  readonly bindingId: string;
  readonly turnId?: string;
  readonly status: "no_wake" | "blocked" | "succeeded" | "failed";
  readonly reason?: string;
  readonly action?: ChatAction["type"];
}

export interface RoomChatDeliveryResult {
  readonly deliveryId: string;
  readonly status: "delivered" | "retry_scheduled";
  readonly eventId?: string;
  readonly error?: string;
}
