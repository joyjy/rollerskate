import type {
  ChatAttentionReceipt,
  ChatDecisionReceipt
} from "../../../infrastructure/sqlite/runtime-mappers.js";
import type { ChatProfileContext, ChatTurnDecision } from "../../chat/model.js";
import type { ChatAttentionPlan } from "../../chat/state-machine.js";
import type {
  AgentResultEvent,
  ChatActivationReason,
  ChatActivationStrategy,
  ChatDispatchEvent,
  ChatMessageEvent,
  Event
} from "../../event/model.js";
import type {
  AgentInvocationDiagnostics,
  AgentInvocationFailure,
  AgentInvocationProgress
} from "../agent-invocation.js";
import type {
  RuntimeDelivery,
  RuntimeDestination,
  RuntimeExecution,
  RuntimeSession
} from "../model.js";

export interface AppendRuntimeEventReceipt {
  readonly event: Event;
  readonly execution: RuntimeExecution;
  readonly status: "accepted" | "duplicate";
}

export interface CompleteRuntimeExecution {
  readonly adapterId: string;
  readonly workspace: string;
  readonly providerSessionId: string;
  readonly sessionId?: string;
  readonly output?: string;
  readonly chatDecision?: ChatTurnDecision;
  readonly chatReplyRoute?: ChatReplyRoute;
  readonly invocation?: AgentInvocationDiagnostics;
}

export interface FailRuntimeExecutionOptions {
  readonly trace?: AgentInvocationFailure;
  readonly retry?: "default" | "never";
}

export interface ChatReplyRoute {
  readonly continueAttention: boolean;
  readonly delivery?: {
    readonly destinationId: string;
    readonly kind: RuntimeDestination["kind"];
    readonly address: Readonly<Record<string, string>>;
  };
}

export type RuntimeExecutionOutcome = AgentResultEvent | ChatMessageEvent | undefined;

export interface AdmitChatAttention {
  readonly plan: ChatAttentionPlan;
  readonly prompt?: string;
  readonly promptResourceId?: string;
  readonly admissionSnapshot?: ChatDispatchEvent["admissionSnapshot"];
  readonly profileContext?: ChatProfileContext;
}

export interface CreateChatActivation {
  readonly sessionId?: string;
  readonly topicId: string;
  readonly reason: ChatActivationReason;
  readonly strategyId: ChatActivationStrategy;
  readonly conversationIntent: import("../../chat/model.js").ConversationIntentSnapshot;
  readonly candidateAgentIds: readonly string[];
  readonly sequentialDispatch?: boolean;
  readonly idempotencyKey: string;
  readonly sourceEventId?: string;
  readonly turnBudget?: number;
  readonly expiresAt?: string;
  readonly strategyRevision?: number;
  readonly contextRevision?: number;
}

export interface RuntimeAudit {
  readonly event: Event;
  readonly execution?: RuntimeExecution;
  readonly resultEvent?: AgentResultEvent;
  readonly resultExecution?: RuntimeExecution;
  readonly session?: RuntimeSession;
  readonly invocation?: AgentInvocationDiagnostics;
  readonly invocationProgress?: AgentInvocationProgress;
  readonly invocationFailure?: AgentInvocationFailure;
  readonly deliveries: ReadonlyArray<{
    readonly delivery: RuntimeDelivery;
    readonly destination: RuntimeDestination;
  }>;
  readonly chat?: {
    readonly promptResourceId?: string;
    readonly attentionReceipts: readonly ChatAttentionReceipt[];
    readonly decisionReceipt?: ChatDecisionReceipt;
  };
}
