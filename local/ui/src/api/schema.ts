import * as v from "valibot";

const nullableString = v.nullable(v.string());
const optionalString = v.optional(v.string());
const stringRecord = v.record(v.string(), v.string());

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
    v.literal("review.requested"),
    v.literal("review.decision"),
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
  target: v.optional(v.object({
    principalId: v.string(),
    handleSnapshot: v.string()
  })),
  dispatchCard: v.optional(v.object({
    sourceMessageEventId: v.string(),
    candidates: v.array(v.object({
      principalId: v.string(),
      handle: v.string()
    }))
  })),
  sourceMessageEventId: optionalString,
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
  presenceTransition: chatPresenceSchema,
  replyEventId: optionalString,
  createdAt: v.string()
});

const runtimeExecutionSchema = v.object({
  executionId: v.string(),
  handler: v.union([
    v.literal("agent"),
    v.literal("result"),
    v.literal("review"),
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
  causalityBoundary: v.nullable(v.union([
    v.literal("complete"),
    v.literal("missing-parent"),
    v.literal("cross-runtime")
  ]))
});

export const runtimeAuditsSchema = v.array(runtimeAuditSchema);

export const runtimeInfoSchema = v.object({
  status: v.union([
    v.literal("running"),
    v.literal("paused"),
    v.literal("degraded"),
    v.literal("stopped")
  ]),
  statusReason: v.string(),
  recommendedAction: v.string(),
  statusSince: v.string(),
  version: v.string(),
  runtimeRoot: v.string(),
  workspaceRoot: v.string(),
  pid: v.nullable(v.number()),
  startedAt: v.nullable(v.string()),
  schemaVersion: v.nullable(v.number()),
  consoleAddress: v.string(),
  lastRefreshedAt: v.string(),
  stale: v.boolean(),
  loop: v.object({
    phase: v.union([v.literal("idle"), v.literal("in_cycle")]),
    totalCycles: v.number(),
    lastCycleStartAt: v.nullable(v.string()),
    lastCycleEndAt: v.nullable(v.string()),
    lastCycleDurationMs: v.nullable(v.number()),
    currentPhaseSummary: v.nullable(v.string())
  }),
  controls: v.object({
    pause: v.boolean(),
    resume: v.boolean(),
    recover: v.boolean()
  }),
  workload: v.object({
    state: v.union([
      v.literal("idle"),
      v.literal("running"),
      v.literal("queued"),
      v.literal("retrying")
    ]),
    ready: v.number(),
    running: v.number(),
    retrying: v.number(),
    total: v.number(),
    asOf: v.string()
  }),
  failures: v.array(v.object({
    failureRef: v.string(),
    owner: v.union([
      v.literal("runtime"),
      v.literal("agent"),
      v.literal("event"),
      v.literal("chat"),
      v.literal("subscription"),
      v.literal("schedule"),
      v.literal("review"),
      v.literal("notice")
    ]),
    severity: v.union([v.literal("warning"), v.literal("error")]),
    reason: v.string(),
    objectRef: v.string(),
    eventId: v.optional(v.string()),
    relatedRef: v.optional(v.string()),
    occurredAt: v.string(),
    action: v.object({
      kind: v.union([
        v.literal("inspect"),
        v.literal("recover"),
        v.literal("reconcile"),
        v.literal("configure")
      ]),
      available: v.boolean(),
      consoleRoute: v.optional(v.string()),
      cliHint: v.string()
    })
  })),
  controlResult: v.nullable(v.object({
    kind: v.union([
      v.literal("pause"),
      v.literal("resume"),
      v.literal("recover")
    ]),
    status: v.union([v.literal("succeeded"), v.literal("failed")]),
    message: v.string(),
    recovered: v.optional(v.number()),
    leftUnknown: v.optional(v.number()),
    failed: v.optional(v.number())
  }))
});

export const localAgentSchema = v.object({
  principalId: v.string(),
  handle: v.string(),
  status: v.union([v.literal("active"), v.literal("suspended")]),
  client: v.union([
    v.literal("codex"),
    v.literal("claude-code"),
    v.literal("kimi-code")
  ]),
  executionConfig: v.object({
    launchArgs: v.array(v.string())
  }),
  createdAt: v.string(),
  updatedAt: v.string()
});

export const localFoundationSchema = v.object({
  deviceId: v.string(),
  deviceName: v.string(),
  workspacePath: v.string(),
  topicId: v.string(),
  topicHandle: v.literal("local"),
  owner: v.object({
    principalId: v.string(),
    kind: v.union([v.literal("owner"), v.literal("agent")]),
    handle: v.string(),
    status: v.union([v.literal("active"), v.literal("suspended")]),
    createdAt: v.string(),
    updatedAt: v.string()
  }),
  createdAt: v.string()
});

export const localSnapshotSchema = v.object({
  foundation: localFoundationSchema,
  agents: v.array(localAgentSchema)
});

export const agentConsoleItemSchema = v.object({
  principalId: v.string(),
  handle: v.string(),
  status: v.union([v.literal("active"), v.literal("suspended")]),
  client: v.union([
    v.literal("codex"),
    v.literal("claude-code"),
    v.literal("kimi-code")
  ]),
  executionConfig: v.object({
    launchArgs: v.array(v.string())
  }),
  availability: v.object({
    state: v.union([
      v.literal("ready"),
      v.literal("unavailable"),
      v.literal("unknown")
    ]),
    reason: optionalString,
    checkedAt: optionalString
  }),
  currentSession: v.optional(v.object({
    sessionId: v.string(),
    generation: v.number(),
    state: v.union([v.literal("created"), v.literal("resumed")]),
    updatedAt: v.string()
  })),
  createdAt: v.string(),
  updatedAt: v.string()
});

export const agentConsoleItemsSchema = v.array(agentConsoleItemSchema);
export const agentMutationResponseSchema = v.looseObject({
  error: optionalString,
  principalId: optionalString
});

export const localChatViewSchema = v.object({
  chat: v.object({
    topicId: v.string(),
    handle: v.literal("local")
  }),
  agents: v.array(localAgentSchema),
  events: v.array(runtimeEventSchema),
  messages: v.object({
    topicId: v.string(),
    items: v.array(v.object({
      eventId: v.string(),
      createdAt: v.string(),
      sender: v.object({
        kind: v.union([v.literal("owner"), v.literal("agent"), v.literal("system")]),
        principalId: optionalString,
        handleSnapshot: v.string()
      }),
      body: v.string(),
      target: v.optional(v.object({
        principalId: v.string(),
        handleSnapshot: v.string()
      })),
      readProgress: v.optional(v.object({
        schema: v.literal("ChatReadProgress@1"),
        total: v.number(),
        read: v.number(),
        agents: v.array(v.object({
          agentId: v.string(),
          handleSnapshot: v.string(),
          state: v.union([
            v.literal("unread"),
            v.literal("reading"),
            v.literal("read"),
            v.literal("failed")
          ]),
          reason: v.string(),
          failureReason: optionalString
        }))
      }))
    })),
    hasEarlier: v.boolean(),
    beforeEventId: optionalString
  }),
  sessions: v.array(v.object({
    principalId: v.string(),
    currentSessionId: optionalString,
    generation: v.number()
  }))
});

export const localChatPresenceViewSchema = v.object({
  topicId: v.string(),
  agents: v.array(v.object({
    principalId: v.string(),
    handle: v.string(),
    status: v.union([v.literal("active"), v.literal("suspended")]),
    global: v.optional(chatPresenceSchema),
    topic: v.optional(chatPresenceSchema)
  }))
});

const agentRunAgentReferenceSchema = v.object({
  principalId: v.string(),
  handle: v.string(),
  client: v.union([
    v.literal("codex"),
    v.literal("claude-code"),
    v.literal("kimi-code")
  ]),
  status: v.union([v.literal("active"), v.literal("suspended")])
});

const agentRunStatusSchema = v.union([
  v.literal("active"),
  v.literal("waiting"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("needs_human"),
  v.literal("cancelled")
]);

export const latestAgentRunViewSchema = v.nullable(v.object({
  summary: v.object({
    runId: v.string(),
    rootEventId: v.string(),
    mandate: v.object({
      kind: v.union([v.literal("objective"), v.literal("workflow")]),
      label: v.string(),
      workflowRef: nullableString
    }),
    steward: agentRunAgentReferenceSchema,
    workspace: v.nullable(v.object({
      root: v.string(),
      access: v.union([v.literal("read"), v.literal("write")]),
      admittedRevision: v.string()
    })),
    progress: v.object({
      steps: v.number(),
      maxSteps: v.number(),
      maxDepth: v.number()
    }),
    status: agentRunStatusSchema,
    terminalSummary: nullableString,
    updatedAt: v.string()
  }),
  projection: v.looseObject({
    runId: v.string(),
    status: agentRunStatusSchema,
    activeStepId: optionalString,
    stepCount: v.number(),
    maxSteps: v.number(),
    maxDepth: v.number()
  }),
  participants: v.array(agentRunAgentReferenceSchema),
  sessions: v.array(v.looseObject({
    sessionId: v.string(),
    agentId: v.string(),
    runId: optionalString,
    adapterId: v.string(),
    providerSessionId: v.string(),
    workspace: v.string(),
    createdAt: v.string(),
    updatedAt: v.string()
  })),
  exchanges: v.array(v.object({
    fromAgentId: v.string(),
    toAgentId: v.string(),
    kind: v.union([v.literal("delegate"), v.literal("callback")]),
    requestEventId: v.string(),
    stepId: v.string(),
    createdAt: v.string()
  })),
  exchangeCounts: v.array(v.object({
    fromAgentId: v.string(),
    toAgentId: v.string(),
    delegates: v.number(),
    callbacks: v.number(),
    total: v.number()
  })),
  timeline: v.array(v.unknown()),
  currentWorkspaceRevision: v.nullable(v.unknown()),
  workspaceRevisionError: nullableString,
}));

export const cancelAgentRunReceiptSchema = v.looseObject({
  status: v.union([v.literal("cancelled"), v.literal("already_terminal")]),
  cancelledExecutions: v.number(),
  run: v.looseObject({
    runId: v.string(),
    status: agentRunStatusSchema
  })
});

export const subscriptionSchema = v.object({
  id: v.string(),
  title: v.string(),
  status: v.union([
    v.literal("active"),
    v.literal("paused"),
    v.literal("running"),
    v.literal("triggered"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("unknown"),
    v.literal("cancelled"),
    v.literal("expired")
  ]),
  owner: v.object({
    agentId: v.string(),
    handle: v.string(),
    client: v.union([
      v.literal("codex"),
      v.literal("claude-code"),
      v.literal("kimi-code")
    ])
  }),
  callback: v.object({
    providerSessionId: v.string(),
    adapterId: v.string(),
    workspace: v.string(),
    localSessionId: nullableString,
    prompt: v.string()
  }),
  probe: v.object({
    plugin: v.object({
      id: v.string(),
      path: v.string(),
      schemaVersion: v.number()
    }),
    policy: v.object({
      allowedHttpOrigins: v.array(v.string()),
      allowedExecutables: v.array(v.string()),
      allowedEnvironment: v.array(v.string()),
      timeoutMilliseconds: v.number(),
      maxOutputBytes: v.number()
    })
  }),
  schedule: v.object({
    intervalMilliseconds: v.number(),
    maxWaitMilliseconds: v.number(),
    maxAttempts: v.number(),
    attemptCount: v.number(),
    deadlineAt: v.string(),
    nextPollAt: v.string()
  }),
  createdAt: v.string(),
  updatedAt: v.string(),
  fireEventId: nullableString,
  latestError: nullableString
});

export const subscriptionsSchema = v.array(subscriptionSchema);

const operationAgentReferenceSchema = v.object({
  principalId: v.string(),
  handle: v.string(),
  client: v.union([
    v.literal("codex"),
    v.literal("claude-code"),
    v.literal("kimi-code")
  ]),
  status: v.union([v.literal("active"), v.literal("suspended")])
});

export const reviewSummaryViewSchema = v.object({
  rootEventId: v.string(),
  subject: v.object({
    ref: v.string(),
    name: v.string(),
    revision: v.string()
  }),
  reviewer: operationAgentReferenceSchema,
  implementer: operationAgentReferenceSchema,
  phase: v.union([
    v.literal("reviewing"),
    v.literal("implementing"),
    v.literal("terminal")
  ]),
  statusReason: v.string(),
  cycleIndex: v.number(),
  revisions: v.object({
    artifact: nullableString,
    implementation: v.string()
  }),
  rework: v.object({
    count: v.number(),
    limit: v.number()
  }),
  findings: v.object({
    open: v.number(),
    resolved: v.number(),
    total: v.number()
  }),
  terminalDecision: v.nullable(v.union([
    v.literal("passed"),
    v.literal("blocked")
  ])),
  terminalReason: nullableString,
  availableActions: v.object({
    recover: v.boolean()
  }),
  failure: v.nullable(v.object({
    failureRef: v.string(),
    consoleRoute: v.string()
  })),
  updatedAt: v.string()
});

const reviewFindingSchema = v.object({
  findingId: v.string(),
  anchor: v.object({
    ref: v.string(),
    line: v.number()
  }),
  severity: v.union([
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
    v.literal("critical")
  ]),
  summary: v.string(),
  status: v.union([v.literal("open"), v.literal("resolved")]),
  reviewerAgentId: v.string(),
  implementerReplies: v.array(v.object({
    implementerAgentId: v.string(),
    summary: v.string(),
    evidenceRefs: v.array(v.string()),
    at: v.string()
  })),
  resolutionEvidence: v.array(v.object({
    reviewerAgentId: v.string(),
    summary: v.string(),
    revisionsRead: v.array(v.string()),
    at: v.string()
  }))
});

export const reviewDetailViewSchema = v.object({
  summary: reviewSummaryViewSchema,
  artifactRef: v.string(),
  artifact: v.nullable(v.object({
    schemaVersion: v.literal("mrsf.review@1"),
    subject: v.object({
      ref: v.string(),
      revision: v.string()
    }),
    rootReviewId: v.string(),
    artifactRevision: v.string(),
    findings: v.array(reviewFindingSchema)
  })),
  artifactError: nullableString,
  workspaceRevision: v.nullable(v.looseObject({
    schemaVersion: v.string(),
    revision: v.string(),
    repoIdentity: v.string(),
    head: v.string(),
    clean: v.boolean()
  })),
  workspaceRevisionError: nullableString,
  audit: v.array(runtimeAuditSchema)
});

export const reviewSummaryViewsSchema = v.array(reviewSummaryViewSchema);

const scheduledRunViewSchema = v.object({
  runId: v.string(),
  scheduleId: v.string(),
  occurrenceKey: v.string(),
  scheduledFor: v.string(),
  scheduleRevision: v.number(),
  status: v.union([
    v.literal("queued"),
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("skipped"),
    v.literal("unknown")
  ]),
  statusReason: v.string(),
  eventId: nullableString,
  executionId: nullableString,
  sessionId: nullableString,
  decisionReason: nullableString,
  availableActions: v.object({
    resolveSucceeded: v.boolean(),
    resolveFailed: v.boolean()
  }),
  failure: v.nullable(v.object({
    failureRef: v.string(),
    consoleRoute: v.string()
  })),
  createdAt: v.string(),
  updatedAt: v.string(),
  completedAt: nullableString,
  audit: v.nullable(runtimeAuditSchema)
});

export const scheduleSummaryViewSchema = v.object({
  scheduleId: v.string(),
  status: v.union([
    v.literal("active"),
    v.literal("paused"),
    v.literal("completed"),
    v.literal("cancelled")
  ]),
  statusReason: v.string(),
  currentRevision: v.number(),
  nextRunAt: nullableString,
  nextOccurrenceMissing: v.boolean(),
  kind: v.union([v.literal("once"), v.literal("cron")]),
  expression: v.string(),
  timezone: nullableString,
  sessionPolicy: v.union([
    v.literal("new_each_run"),
    v.literal("fixed")
  ]),
  fixedSessionId: nullableString,
  owner: operationAgentReferenceSchema,
  agent: operationAgentReferenceSchema,
  runCounts: v.object({
    queued: v.number(),
    running: v.number(),
    succeeded: v.number(),
    failed: v.number(),
    skipped: v.number(),
    unknown: v.number()
  }),
  availableActions: v.object({
    pause: v.boolean(),
    resume: v.boolean(),
    cancel: v.boolean(),
    runNow: v.boolean()
  }),
  updatedAt: v.string()
});

export const scheduleDetailViewSchema = v.object({
  summary: scheduleSummaryViewSchema,
  revision: v.object({
    revision: v.number(),
    misfirePolicy: v.union([v.literal("skip"), v.literal("run_once")]),
    overlapPolicy: v.union([v.literal("skip"), v.literal("queue")]),
    misfireGraceMilliseconds: v.number(),
    prompt: v.string(),
    workspace: v.string(),
    createdAt: v.string()
  }),
  runs: v.array(scheduledRunViewSchema)
});

export const scheduleSummaryViewsSchema = v.array(scheduleSummaryViewSchema);
export const scheduleRunNowResponseSchema = v.object({
  receipt: v.looseObject({
    status: v.union([v.literal("accepted"), v.literal("duplicate")]),
    run: v.looseObject({
      runId: v.string(),
      status: v.string()
    })
  }),
  schedule: scheduleDetailViewSchema
});
export const scheduleResolveResponseSchema = v.object({
  run: scheduledRunViewSchema,
  schedule: scheduleDetailViewSchema
});

export const noticeSummaryViewSchema = v.object({
  noticeId: v.string(),
  title: v.string(),
  summary: v.string(),
  outcome: v.union([v.literal("succeeded"), v.literal("failed")]),
  deliveryStatus: v.union([
    v.literal("pending"),
    v.literal("delivering"),
    v.literal("retry_wait"),
    v.literal("delivered"),
    v.literal("failed")
  ]),
  statusReason: v.string(),
  source: v.object({
    kind: v.literal("delivery"),
    sourceId: v.string(),
    subscriptionId: nullableString
  }),
  references: v.object({
    eventId: v.string(),
    deliveryId: v.string(),
    destinationId: v.string()
  }),
  sourceAction: v.object({
    label: v.string(),
    consoleRoute: v.string(),
    cliHint: v.string()
  }),
  failure: v.nullable(v.object({
    failureRef: v.string(),
    consoleRoute: v.string()
  })),
  occurredAt: v.string(),
  deliveredAt: nullableString,
  readAt: nullableString,
  acknowledgedAt: nullableString,
  availableActions: v.object({
    markRead: v.boolean(),
    acknowledge: v.boolean()
  })
});

export const noticeDetailViewSchema = v.object({
  summary: noticeSummaryViewSchema,
  projection: v.object({
    projectionUpdatedAt: v.string(),
    stateUpdatedAt: nullableString,
    deliveryError: nullableString
  })
});

export const noticeCenterViewSchema = v.object({
  counts: v.object({
    total: v.number(),
    unread: v.number(),
    unacknowledged: v.number()
  }),
  notices: v.array(noticeSummaryViewSchema)
});

export const errorResponseSchema = v.looseObject({
  error: v.optional(v.string())
});

export type RuntimeInfoOutput = v.InferOutput<typeof runtimeInfoSchema>;
export type RuntimeAuditOutput = v.InferOutput<typeof runtimeAuditSchema>;
export type LocalSnapshotOutput = v.InferOutput<typeof localSnapshotSchema>;
export type LocalChatViewOutput = v.InferOutput<typeof localChatViewSchema>;
export type LatestAgentRunViewOutput = v.InferOutput<typeof latestAgentRunViewSchema>;
export type AgentConsoleItemOutput = v.InferOutput<typeof agentConsoleItemSchema>;
export type SubscriptionOutput = v.InferOutput<typeof subscriptionSchema>;
export type ReviewSummaryViewOutput = v.InferOutput<typeof reviewSummaryViewSchema>;
export type ReviewDetailViewOutput = v.InferOutput<typeof reviewDetailViewSchema>;
export type ScheduleSummaryViewOutput = v.InferOutput<typeof scheduleSummaryViewSchema>;
export type ScheduleDetailViewOutput = v.InferOutput<typeof scheduleDetailViewSchema>;
export type ScheduledRunViewOutput = v.InferOutput<typeof scheduledRunViewSchema>;
export type NoticeSummaryViewOutput = v.InferOutput<typeof noticeSummaryViewSchema>;
export type NoticeDetailViewOutput = v.InferOutput<typeof noticeDetailViewSchema>;
export type NoticeCenterViewOutput = v.InferOutput<typeof noticeCenterViewSchema>;
