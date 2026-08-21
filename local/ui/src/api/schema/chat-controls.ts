import * as v from "valibot";

const intentPolicySchema = v.union([
  v.object({ kind: v.literal("continue_recent") }),
  v.object({ kind: v.literal("choose_from_themes") }),
  v.object({ kind: v.literal("fixed_directed"), brief: v.string() })
]);

const conversationIntentSchema = v.object({
  schema: v.literal("ConversationIntentSnapshot@1"),
  mode: v.union([
    v.literal("continue_recent"),
    v.literal("selected_theme"),
    v.literal("directed")
  ]),
  brief: v.optional(v.string()),
  themeId: v.optional(v.string()),
  governanceRevision: v.number()
});

const governanceReceiptSchema = v.object({
  schema: v.literal("TopicGovernanceControlReceipt@1"),
  receiptId: v.string(),
  topicId: v.string(),
  action: v.union([
    v.literal("materialize_default"),
    v.literal("pause"),
    v.literal("resume"),
    v.literal("participant_add"),
    v.literal("participant_remove"),
    v.literal("strategy_policy_update"),
    v.literal("conversation_policy_update")
  ]),
  actor: v.object({
    kind: v.union([v.literal("system"), v.literal("owner")]),
    principalId: v.optional(v.string())
  }),
  previousRevision: v.nullable(v.number()),
  resultingRevision: v.number(),
  changedFields: v.array(v.string()),
  createdAt: v.string()
});

export const topicGovernanceViewSchema = v.object({
  governance: v.object({
    topicId: v.string(),
    status: v.union([v.literal("active"), v.literal("paused")]),
    participants: v.array(v.object({
      agentId: v.string(),
      status: v.union([v.literal("active"), v.literal("removed")]),
      joinedAt: v.string(),
      removedAt: v.optional(v.string()),
      governanceRevision: v.number()
    })),
    strategyPolicy: v.object({
      starterEnabled: v.boolean(),
      participantMessageEnabled: v.boolean(),
      scheduledEnabled: v.boolean()
    }),
    conversationPolicy: v.object({
      defaultIntent: v.union([
        v.literal("continue_recent"),
        v.literal("choose_from_themes")
      ]),
      themes: v.array(v.object({
        themeId: v.string(),
        title: v.string(),
        brief: v.string(),
        status: v.union([v.literal("active"), v.literal("archived")])
      }))
    }),
    revision: v.number(),
    createdAt: v.string(),
    updatedAt: v.string()
  }),
  activeParticipantAgentIds: v.array(v.string()),
  recentReceipts: v.array(governanceReceiptSchema),
  actionAvailability: v.object({
    expectedRevision: v.number(),
    pause: v.boolean(),
    resume: v.boolean(),
    resumeAndWake: v.boolean(),
    participantAddAgentIds: v.array(v.string()),
    participantRemoveAgentIds: v.array(v.string())
  })
});

const freeChatReceiptSchema = v.object({
  schema: v.literal("FreeChatModeReceipt@1"),
  receiptId: v.string(),
  modeId: v.string(),
  topicId: v.string(),
  sequence: v.number(),
  action: v.union([
    v.literal("started"),
    v.literal("contribution_observed"),
    v.literal("roster_changed"),
    v.literal("activation_admitted"),
    v.literal("cycle_silent"),
    v.literal("continued_now"),
    v.literal("exited"),
    v.literal("stopped")
  ]),
  previousRevision: v.nullable(v.number()),
  resultingRevision: v.number(),
  cycleIndex: v.number(),
  details: v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
  createdAt: v.string()
});

const freeChatModeSchema = v.object({
  modeId: v.string(),
  topicId: v.string(),
  status: v.union([
    v.literal("active"),
    v.literal("exited"),
    v.literal("stopped"),
    v.literal("expired")
  ]),
  intentPolicy: intentPolicySchema,
  strategyRevision: v.literal(1),
  limits: v.object({
    maxDurationMinutes: v.number(),
    maxCycles: v.number(),
    maxTurns: v.number(),
    consecutiveSilenceLimit: v.number()
  }),
  cycleIndex: v.number(),
  sample: v.object({
    cycleIndex: v.number(),
    sampledAt: v.string(),
    idleDelayMinutes: v.number(),
    idleDeadline: v.string(),
    participantCount: v.number(),
    candidateAgentIds: v.array(v.string()),
    conversationIntent: conversationIntentSchema
  }),
  lastMeaningfulActivityAt: v.string(),
  lastMeaningfulEventId: v.optional(v.string()),
  consecutiveSilentCycles: v.number(),
  admittedTurns: v.number(),
  pendingActivationEventId: v.optional(v.string()),
  revision: v.number(),
  startedAt: v.string(),
  updatedAt: v.string(),
  stoppedAt: v.optional(v.string()),
  stopReason: v.optional(v.union([
    v.literal("owner_exit"),
    v.literal("topic_paused"),
    v.literal("empty_roster"),
    v.literal("consecutive_silence"),
    v.literal("max_duration"),
    v.literal("max_cycles"),
    v.literal("max_turns")
  ]))
});

export const freeChatModeViewSchema = v.object({
  mode: v.optional(freeChatModeSchema),
  recentReceipts: v.array(freeChatReceiptSchema),
  actionAvailability: v.object({
    start: v.boolean(),
    continueNow: v.boolean(),
    exit: v.boolean(),
    expectedRevision: v.optional(v.number())
  })
});

const topicScheduleReceiptSchema = v.object({
  schema: v.literal("TopicActivationScheduleReceipt@1"),
  receiptId: v.string(),
  scheduleId: v.string(),
  topicId: v.string(),
  sequence: v.number(),
  action: v.union([
    v.literal("created"),
    v.literal("paused"),
    v.literal("resumed"),
    v.literal("cancelled"),
    v.literal("occurrence_admitted"),
    v.literal("occurrence_skipped"),
    v.literal("occurrence_failed")
  ]),
  resultingRevision: v.number(),
  occurrenceKey: v.optional(v.string()),
  scheduledFor: v.optional(v.string()),
  activationEventId: v.optional(v.string()),
  reason: v.optional(v.string()),
  createdAt: v.string()
});

export const topicActivationScheduleViewSchema = v.object({
  schedule: v.object({
    scheduleId: v.string(),
    topicId: v.string(),
    status: v.union([
      v.literal("active"),
      v.literal("paused"),
      v.literal("cancelled"),
      v.literal("completed")
    ]),
    kind: v.union([v.literal("once"), v.literal("cron")]),
    expression: v.string(),
    timezone: v.optional(v.string()),
    misfirePolicy: v.union([v.literal("skip"), v.literal("run_once")]),
    misfireGraceMilliseconds: v.number(),
    candidatePolicy: v.union([
      v.literal("deterministic_one"),
      v.literal("sampled_sequential"),
      v.literal("all_available")
    ]),
    intentPolicy: intentPolicySchema,
    turnBudget: v.number(),
    nextRunAt: v.optional(v.string()),
    nextOccurrenceKey: v.optional(v.string()),
    revision: v.number(),
    createdAt: v.string(),
    updatedAt: v.string()
  }),
  receipts: v.array(topicScheduleReceiptSchema)
});

export const topicActivationScheduleViewsSchema = v.array(
  topicActivationScheduleViewSchema
);

export type TopicGovernanceViewOutput = v.InferOutput<typeof topicGovernanceViewSchema>;
export type FreeChatModeViewOutput = v.InferOutput<typeof freeChatModeViewSchema>;
export type TopicActivationScheduleViewOutput = v.InferOutput<
  typeof topicActivationScheduleViewSchema
>;
