import * as v from "valibot";
import { nullableString, optionalString, stringRecord } from "./shared";

const causalitySchema = v.object({
  rootEventId: v.string(),
  parentEventId: optionalString,
  hop: v.number()
});

export const runtimeEventSchema = v.looseObject({
  eventId: v.string(),
  type: v.union([
    v.literal("agent.request"),
    v.literal("subscription.fire"),
    v.literal("agent.result"),
    v.literal("chat.activation"),
    v.literal("chat.message"),
    v.literal("chat.dispatch")
  ]),
  source: v.object({
    kind: v.union([
      v.literal("cli"),
      v.literal("subscription"),
      v.literal("schedule"),
      v.literal("matrix"),
      v.literal("server"),
      v.literal("handler")
    ]),
    externalId: optionalString
  }),
  agentId: optionalString,
  prompt: optionalString,
  boundedPromptSummary: optionalString,
  outcome: v.optional(v.union([v.literal("succeeded"), v.literal("failed")])),
  output: optionalString,
  error: optionalString,
  sessionId: optionalString,
  destinationIds: v.array(v.string()),
  causality: causalitySchema,
  createdAt: v.string(),
  topicId: optionalString,
  sender: v.optional(v.object({
    kind: v.union([v.literal("owner"), v.literal("agent"), v.literal("system")]),
    principalId: optionalString,
    handleSnapshot: v.string()
  })),
  body: optionalString,
  targets: v.optional(v.array(v.object({
    principalId: v.string(),
    handleSnapshot: v.string()
  }))),
  dispatchCard: v.optional(v.object({
    sourceMessageEventId: v.string(),
    candidates: v.array(v.object({
      principalId: v.string(),
      handle: v.string()
    }))
  })),
  sourceMessageEventId: optionalString,
  sourceAttentionEventId: optionalString,
  reason: optionalString,
  strategyId: optionalString,
  strategyRevision: v.optional(v.number()),
  contextRevision: v.optional(v.number()),
  candidateAgentIds: v.optional(v.array(v.string())),
  turnBudget: v.optional(v.number()),
  expiresAt: optionalString,
  targetHandleSnapshot: optionalString,
  promptResourceId: optionalString
});

export const chatPresenceSchema = v.object({
  scope: v.union([v.literal("topic"), v.literal("global")]),
  mode: v.union([v.literal("available"), v.literal("snoozed")]),
  until: optionalString,
  wakeKeywords: v.array(v.string())
});

const chatAttentionReceiptSchema = v.object({
  sourceMessageEventId: v.string(),
  agentId: v.string(),
  outcome: v.union([v.literal("dispatched"), v.literal("skipped")]),
  reason: v.string(),
  presenceSnapshot: v.object({
    global: chatPresenceSchema,
    topic: chatPresenceSchema
  }),
  dispatchEventId: optionalString,
  promptResourceId: optionalString,
  createdAt: v.string()
});

const chatDecisionReceiptSchema = v.object({
  dispatchEventId: v.string(),
  speechAction: v.union([v.literal("reply"), v.literal("silent")]),
  presenceTransition: v.optional(chatPresenceSchema),
  replyEventId: optionalString,
  createdAt: v.string()
});

const runtimeExecutionSchema = v.object({
  executionId: v.string(),
  handler: v.union([
    v.literal("agent"),
    v.literal("result"),
    v.literal("chat")
  ]),
  status: v.string(),
  attemptCount: v.number(),
  maxAttempts: v.number(),
  firstStartedAt: nullableString,
  lastAttemptAt: nullableString,
  completedAt: nullableString,
  nextAttemptAt: v.string(),
  lastError: optionalString
});

const runtimeResultEventSchema = v.object({
  eventId: v.string(),
  type: v.literal("agent.result"),
  outcome: v.union([v.literal("succeeded"), v.literal("failed")]),
  sessionId: optionalString,
  output: optionalString,
  error: optionalString,
  causality: causalitySchema,
  createdAt: v.string()
});

const runtimeSessionSchema = v.object({
  sessionId: v.string(),
  agentId: v.string(),
  adapterId: v.string(),
  providerSessionId: v.string(),
  workspace: v.string(),
  createdAt: v.string(),
  resumedAt: nullableString
});

const agentTokenUsageSchema = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  cacheReadTokens: v.optional(v.number()),
  cacheCreationTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  costUsd: v.optional(v.number())
});

const agentToolUsageSchema = v.object({
  name: v.string(),
  count: v.number()
});

export const agentInvocationDiagnosticsSchema = v.object({
  schemaVersion: v.literal("AgentInvocationDiagnostics@1"),
  effectivePrompt: v.string(),
  startedAt: v.string(),
  completedAt: v.string(),
  durationMilliseconds: v.number(),
  tokenUsage: v.optional(agentTokenUsageSchema),
  toolUsage: v.optional(v.array(agentToolUsageSchema)),
  turnCount: v.optional(v.number())
});

const agentTurnResultMandateSchema = v.union([
  v.object({
    kind: v.literal("objective"),
    objective: v.string()
  }),
  v.object({
    kind: v.literal("workflow"),
    workflowRef: v.string(),
    inputs: v.record(v.string(), v.unknown())
  })
]);

const agentTurnOutputSchema = v.object({
  id: v.string(),
  title: v.string(),
  contentType: v.union([
    v.literal("application/json"),
    v.literal("text/markdown"),
    v.literal("text/plain")
  ]),
  schemaVersion: v.optional(v.string()),
  value: v.unknown()
});

export const agentTurnResultSchema = v.union([
  v.object({
    schemaVersion: v.literal("AgentTurnResult@1"),
    action: v.literal("complete"),
    outcome: v.union([
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("needs_human")
    ]),
    summary: v.string(),
    artifactRefs: v.array(v.string()),
    outputs: v.optional(v.array(agentTurnOutputSchema)),
    observedWorkspaceRevision: v.optional(v.string())
  }),
  v.object({
    schemaVersion: v.literal("AgentTurnResult@1"),
    action: v.literal("delegate"),
    targetAgentId: v.string(),
    mandate: agentTurnResultMandateSchema,
    summary: v.string(),
    artifactRefs: v.array(v.string()),
    observedWorkspaceRevision: v.optional(v.string())
  })
]);

export const agentStepResultSchema = v.object({
  schemaVersion: v.literal("AgentStepResult@1"),
  outcome: v.union([
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("needs_human")
  ]),
  summary: v.string(),
  artifactRefs: v.array(v.string()),
  acceptanceEvidence: v.optional(v.array(v.string())),
  unresolvedQuestions: v.optional(v.array(v.string())),
  observedWorkspaceRevision: v.optional(v.string())
});

const runtimeDeliverySchema = v.object({
  delivery: v.looseObject({
    deliveryId: v.string(),
    resultEventId: v.string(),
    status: v.string(),
    attemptCount: v.number(),
    source: v.string(),
    createdAt: v.string(),
    attemptedAt: nullableString,
    deliveredAt: nullableString,
    receipt: optionalString,
    boundedError: optionalString,
    lastError: optionalString
  }),
  destination: v.looseObject({
    destinationId: v.string(),
    kind: v.string(),
    address: stringRecord
  })
});

export const runtimeAuditSchema = v.object({
  event: runtimeEventSchema,
  execution: v.optional(v.nullable(runtimeExecutionSchema)),
  resultEvent: v.optional(v.nullable(runtimeResultEventSchema)),
  resultExecution: v.optional(v.nullable(runtimeExecutionSchema)),
  session: v.optional(v.nullable(runtimeSessionSchema)),
  invocation: v.optional(v.nullable(agentInvocationDiagnosticsSchema)),
  deliveries: v.array(runtimeDeliverySchema),
  chat: v.optional(v.object({
    promptResourceId: optionalString,
    attentionReceipts: v.array(chatAttentionReceiptSchema),
    decisionReceipt: v.optional(chatDecisionReceiptSchema)
  })),
  lifecycleChangedAt: v.string(),
  reasonForIntervention: nullableString,
  directChildren: v.array(v.object({
    eventId: v.string(),
    type: v.string(),
    status: v.string()
  })),
  conversationTimeline: v.optional(v.array(v.object({
    eventId: v.string(),
    type: v.union([
      v.literal("chat.activation"),
      v.literal("chat.message"),
      v.literal("chat.dispatch")
    ]),
    parentEventId: optionalString,
    agentId: optionalString,
    agentHandle: optionalString,
    sessionId: optionalString,
    executionId: optionalString,
    status: v.string(),
    outcome: optionalString,
    reason: optionalString,
    createdAt: v.string(),
    completedAt: optionalString,
    durationMilliseconds: v.optional(v.number())
  }))),
  causalityBoundary: v.nullable(v.union([
    v.literal("complete"),
    v.literal("missing-parent"),
    v.literal("cross-runtime")
  ]))
});

export const runtimeAuditsSchema = v.array(runtimeAuditSchema);

export type RuntimeAuditOutput = v.InferOutput<typeof runtimeAuditSchema>;
export type RuntimeEventOutput = v.InferOutput<typeof runtimeEventSchema>;
export type RuntimeExecutionOutput = NonNullable<RuntimeAuditOutput["execution"]>;
export type RuntimeResultEventOutput = NonNullable<RuntimeAuditOutput["resultEvent"]>;
export type RuntimeSessionOutput = NonNullable<RuntimeAuditOutput["session"]>;
export type RuntimeDeliveryOutput = RuntimeAuditOutput["deliveries"][number];
export type ChatPresenceOutput = v.InferOutput<typeof chatPresenceSchema>;
export type AgentInvocationDiagnosticsOutput = v.InferOutput<typeof agentInvocationDiagnosticsSchema>;
export type AgentTurnResultOutput = v.InferOutput<typeof agentTurnResultSchema>;
export type AgentStepResultOutput = v.InferOutput<typeof agentStepResultSchema>;
