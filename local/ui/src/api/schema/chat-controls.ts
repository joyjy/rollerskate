import * as v from "valibot";

const intentPolicySchema = v.union([
  v.object({ kind: v.literal("continue_recent") }),
  v.object({ kind: v.literal("choose_from_themes") }),
  v.object({ kind: v.literal("fixed_directed"), brief: v.string() })
]);

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
    participantAddAgentIds: v.array(v.string()),
    participantRemoveAgentIds: v.array(v.string())
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
export type TopicActivationScheduleViewOutput = v.InferOutput<
  typeof topicActivationScheduleViewSchema
>;
