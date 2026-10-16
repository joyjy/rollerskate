import * as v from "valibot";
import {
  agentInvocationDiagnosticsSchema,
  agentTurnOutputSchema,
  agentStepResultSchema,
  agentTurnResultSchema
} from "./event";
import { nullableString, optionalString, runHumanQuestionSchema, runInterventionSchema } from "./shared";

const agentRunAgentReferenceSchema = v.object({
  principalId: v.string(),
  handle: v.string(),
  client: v.string(),
  status: v.union([v.literal("active"), v.literal("suspended")])
});

const agentRunStatusSchema = v.union([
  v.literal("active"),
  v.literal("waiting"),
  v.literal("awaiting_source"),
  v.literal("awaiting_orchestrator"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("needs_human"),
  v.literal("cancelled")
]);

const runDecisionTargetSchema = v.variant("kind", [
  v.object({ kind: v.literal("self") }),
  v.object({ kind: v.literal("agent"), agentId: v.string() })
]);

const runDecisionMandateSchema = v.variant("kind", [
  v.object({ kind: v.literal("objective"), objective: v.string() }),
  v.object({
    kind: v.literal("workflow"),
    workflowRef: v.string(),
    inputs: v.record(v.string(), v.unknown())
  })
]);

const orchestratorStateSchema = v.object({
  schemaVersion: v.literal("OrchestratorState@1"),
  goal: v.string(),
  tasks: v.array(v.object({
    taskId: v.string(),
    objective: v.string(),
    status: v.union([
      v.literal("pending"),
      v.literal("active"),
      v.literal("completed"),
      v.literal("blocked")
    ]),
    assignedAgentId: optionalString,
    summary: optionalString
  })),
  acceptedEvidence: v.array(v.string()),
  unresolvedQuestions: v.array(v.string())
});

const runDecisionCommonSchema = {
  expectedRunVersion: v.number(),
  rationale: v.string(),
  checkedAcceptance: v.array(v.string()),
  state: orchestratorStateSchema
};

const runDecisionV2Schema = v.variant("action", [
  v.object({
    schemaVersion: v.literal("RunDecision@2"),
    ...runDecisionCommonSchema,
    action: v.literal("next_step"),
    nextStep: v.object({
      target: runDecisionTargetSchema,
      mandate: runDecisionMandateSchema
    })
  }),
  v.object({
    schemaVersion: v.literal("RunDecision@2"),
    ...runDecisionCommonSchema,
    action: v.literal("finish"),
    finish: v.object({
      outcome: v.union([v.literal("succeeded"), v.literal("failed")]),
      summary: v.string()
    })
  }),
  v.object({
    schemaVersion: v.literal("RunDecision@2"),
    ...runDecisionCommonSchema,
    action: v.literal("needs_human")
  })
]);

const runDecisionModernSchema = v.variant("action", [
  v.object({
    schemaVersion: v.union([v.literal("RunDecision@3"),v.literal("RunDecision@4"),v.literal("RunDecision@5")]),
    ...runDecisionCommonSchema,
    action: v.literal("next_step"),
    nextStep: v.object({
      target: runDecisionTargetSchema,
      mandate: runDecisionMandateSchema
    })
  }),
  v.object({
    schemaVersion: v.union([v.literal("RunDecision@3"),v.literal("RunDecision@4"),v.literal("RunDecision@5")]),
    ...runDecisionCommonSchema,
    action: v.literal("await_source"),
    awaitSource: v.object({
      sourceKind: v.union([
        v.literal("schedule"),
        v.literal("subscription"),
        v.literal("continuous_subscription")
      ]),
      templateId: v.string(),
      parameters: v.record(v.string(), v.unknown())
    })
  }),
  v.object({
    schemaVersion: v.union([v.literal("RunDecision@3"),v.literal("RunDecision@4"),v.literal("RunDecision@5")]),
    ...runDecisionCommonSchema,
    action: v.literal("finish"),
    finish: v.object({
      scope: v.union([v.literal("cycle"), v.literal("run")]),
      outputs:v.optional(v.array(agentTurnOutputSchema)),
      outcome: v.union([v.literal("succeeded"), v.literal("failed")]),
      summary: v.string()
    })
  }),
  v.object({
    schemaVersion: v.union([v.literal("RunDecision@3"),v.literal("RunDecision@4"),v.literal("RunDecision@5")]),
    ...runDecisionCommonSchema,
    action: v.literal("needs_human")
  })
]);

const runDecisionV6CommonSchema = {
  ...runDecisionCommonSchema,
  schemaVersion: v.literal("RunDecision@6"),
  checkedAcceptance: v.array(v.object({
    id: v.string(),
    status: v.picklist(["pass", "fail", "unknown"]),
    evidenceRefs: v.array(v.string())
  }))
};
const runDecisionV6Schema = v.variant("action", [
  ...runDecisionModernSchema.options.map(schema => v.object({
    ...schema.entries, ...runDecisionV6CommonSchema
  })),
  v.object({...runDecisionV6CommonSchema, action: v.literal("ask_human"), question: v.string()}),
  v.object({...runDecisionV6CommonSchema, action: v.literal("request_capability"), capability: v.object({
    kind: v.literal("network"), acceptanceIds: v.array(v.string()), targets: v.array(v.string()), reason: v.string()
  })})
]);

export const agentRunDecisionSchema = v.union([
  runDecisionV6Schema,
  runDecisionModernSchema,
  v.object({schemaVersion:v.literal("RunDecision@5"),...runDecisionCommonSchema,action:v.literal("ask_human"),question:v.string()}),
  runDecisionV2Schema
]);

const agentRunDecisionReceiptCommonSchema = {
  runId: v.string(),
  requestId: v.string(),
  expectedRunVersion: v.number(),
  resultingRunVersion: v.number(),
  sourceStepId: v.string(),
  targetAgentId: optionalString,
  nextStepId: optionalString,
  nextEventId: optionalString,
  nextExecutionId: optionalString,
  terminalStatus: v.optional(v.union([
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("needs_human")
  ])),
  acceptedAt: v.string()
};

export const agentRunDecisionReceiptSchema = v.variant("schemaVersion", [
  v.object({schemaVersion:v.literal("AgentRunDecisionReceipt@3"),...agentRunDecisionReceiptCommonSchema,action:v.picklist(["ask_human", "request_capability"]),questionId:v.string(),resultingRunStatus:v.literal("awaiting_orchestrator")}),
  v.looseObject({
    schemaVersion: v.literal("AgentRunDecisionReceipt@1"),
    ...agentRunDecisionReceiptCommonSchema,
    action: v.union([
      v.literal("next_step"),
      v.literal("finish"),
      v.literal("needs_human")
    ])
  }),
  v.looseObject({
    schemaVersion: v.literal("AgentRunDecisionReceipt@2"),
    ...agentRunDecisionReceiptCommonSchema,
    action: v.union([
      v.literal("next_step"),
      v.literal("await_source"),
      v.literal("finish"),
      v.literal("needs_human")
    ]),
    resultingRunStatus: v.union([
      v.literal("active"),
      v.literal("awaiting_source"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("needs_human")
    ]),
    finishScope: v.optional(v.union([v.literal("cycle"), v.literal("run")])),
    sourceBinding: v.optional(v.unknown()),
    cycleId: optionalString
  })
]);

export const agentRunSummarySchema = v.object({
  runId: v.string(),
  rootEventId: v.string(),
  series: v.nullable(v.object({
    key: v.string(),
    activeCycleId: nullableString
  })),
  source: v.optional(v.nullable(v.object({
    kind: v.union([
      v.literal("schedule"),
      v.literal("subscription"),
      v.literal("continuous_subscription")
    ]),
    id: v.string(),
    definitionRevision: v.string()
  }))),
  orchestrationMode: v.union([v.literal("autonomous"), v.literal("caller")]),
  mandate: v.object({
    kind: v.union([v.literal("objective"), v.literal("workflow")]),
    label: v.string(),
    workflowRef: nullableString
  }),
  steward: agentRunAgentReferenceSchema,
  workspace: v.nullable(v.object({
    root: v.string(),
    access: v.union([v.literal("read"), v.literal("write")]),
    effect: v.optional(v.union([
      v.literal("must_change"),
      v.literal("may_remain_unchanged")
    ])),
    admittedRevision: v.string()
  })),
  progress: v.object({
    steps: v.number(),
    maxSteps: v.number(),
    maxDepth: v.number()
  }),
  status: agentRunStatusSchema,
  terminalSummary: nullableString,
  archivedAt: nullableString,
  updatedAt: v.string()
});

export const chatRunHandoffReceiptSchema = v.looseObject({
  status: v.union([v.literal("accepted"), v.literal("duplicate")]),
  run: v.looseObject({
    runId: v.string(),
    orchestratorBinding: v.optional(v.looseObject({
      schemaVersion: v.literal("OrchestratorBinding@3")
    }))
  })
});

const agentRunDetailViewInnerSchema = v.object({
  intervention: v.optional(v.nullable(runInterventionSchema)),
  humanQuestion:v.optional(v.nullable(runHumanQuestionSchema)),
  capabilityRequest: v.optional(v.nullable(v.object({
    requestEventId: v.string(), runVersion: v.number(), status: v.union([
      v.literal("pending"), v.literal("granted"), v.literal("closed"),
      v.literal("expired"), v.literal("superseded")
    ]), kind: v.literal("network"), acceptanceIds: v.array(v.string()),
    targets: v.array(v.string()), reason: v.string(), continuationEventId: optionalString
  }))),
  summary: agentRunSummarySchema,
  projection: v.looseObject({
    runId: v.string(),
    status: agentRunStatusSchema,
    orchestrationMode: v.union([v.literal("autonomous"), v.literal("caller")]),
    activeStepId: optionalString,
    stepCount: v.number(),
    maxSteps: v.number(),
    maxDepth: v.number()
  }),
  cycles: v.array(v.looseObject({
    cycleId: v.string(),
    runId: v.string(),
    requestId: v.string(),
    sourceRevision: v.string(),
    status: v.union([
      v.literal("active"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("needs_human"),
      v.literal("superseded"),
      v.literal("cancelled")
    ]),
    stepCount: v.number(),
    createdAt: v.string(),
    completedAt: optionalString,
    updatedAt: v.string()
  })),
  triggerSource: v.optional(v.nullable(v.object({
    kind: v.union([
      v.literal("schedule"),
      v.literal("subscription"),
      v.literal("continuous_subscription")
    ]),
    id: v.string(),
    definitionRevision: v.string(),
    status: v.string(),
    diagnosticsRoute: v.string(),
    nextActionAt: nullableString,
    pendingOccurrenceKey: nullableString,
    checkpointOccurrenceKey: nullableString,
    reconcileStatus: v.string(),
    latestError: nullableString,
    lastOccurrence: v.nullable(v.object({
      occurrenceKey: v.string(),
      cycleId: nullableString,
      status: v.string(),
      observedAt: v.string()
    }))
  }))),
  checkpoint: v.nullable(v.object({
    schemaVersion: v.literal("AgentRunCheckpoint@1"),
    stepId: v.string(),
    agentId: v.string(),
    requestEventId: v.string(),
    resultEventId: v.string(),
    executionId: v.string(),
    result: agentStepResultSchema,
    observedWorkspaceRevision: v.optional(v.string()),
    recordedAt: v.string()
  })),
  decisions: v.array(agentRunDecisionReceiptSchema),
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
  steps: v.array(v.object({
    stepId: v.string(),
    cycleId: v.nullable(v.string()),
    parentStepId: v.nullable(v.string()),
    depth: v.number(),
    agent: agentRunAgentReferenceSchema,
    requestEventId: v.string(),
    resultEventId: v.nullable(v.string()),
    status: v.union([
      v.literal("queued"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed")
    ]),
    prompt: v.string(),
    effectivePrompt: v.nullable(v.string()),
    result: v.nullable(v.union([
      agentTurnResultSchema,
      agentStepResultSchema,
      agentRunDecisionSchema
    ])),
    rawOutput: v.nullable(v.string()),
    error: v.nullable(v.string()),
    invocation: v.nullable(agentInvocationDiagnosticsSchema),
    observedWorkspaceRevision: v.nullable(v.string()),
    createdAt: v.string(),
    completedAt: v.nullable(v.string())
  })),
  outputFolders: v.array(v.object({
    cycleId: v.nullable(v.string()),
    sourceRevision: v.nullable(v.string()),
    outputs: v.array(v.object({
      outputId: v.string(),
      stepId: v.string(),
      title: v.string(),
      kind: v.union([
        v.literal("primary"),
        v.literal("output"),
        v.literal("reference")
      ]),
      contentType: v.union([
        v.literal("application/json"),
        v.literal("text/markdown"),
        v.literal("text/plain"),
        v.literal("text/uri-list")
      ]),
      schemaVersion: nullableString,
      value: v.unknown()
    }))
  })),
  timeline: v.array(v.unknown()),
  currentWorkspaceRevision: v.nullable(v.unknown()),
  workspaceRevisionError: nullableString,
});

export const agentRunDetailViewSchema = agentRunDetailViewInnerSchema;
export const deterministicRunDetailViewSchema = v.looseObject({
  runId: v.string(),
  kind: v.union([v.literal("command"), v.literal("observe")]),
  requestId: v.string(),
  title: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
  status: v.union([
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("cancelled"),
    v.literal("unknown"),
    v.literal("attention_required")
  ]),
  result: v.unknown(),
  deliveryStatus: v.string(),
  errors: v.array(v.string())
});
export const runDetailViewSchema = v.union([
  agentRunDetailViewSchema,
  deterministicRunDetailViewSchema
]);
export const agentRunSummariesSchema = v.object({
  items: v.array(agentRunSummarySchema),
  total: v.number(),
  page: v.number(),
  pageSize: v.number()
});

export const cancelAgentRunReceiptSchema = v.looseObject({
  status: v.union([v.literal("cancelled"), v.literal("already_terminal")]),
  cancelledExecutions: v.number(),
  run: v.looseObject({
    runId: v.string(),
    status: agentRunStatusSchema
  })
});
export const answerAgentRunReceiptSchema = v.looseObject({
  status: v.union([v.literal("accepted"), v.literal("already_answered")]),
  runId: v.string(), questionId: v.string(), eventId: v.string(), version: v.optional(v.number())
});
export const authorizeAgentRunCapabilityReceiptSchema = v.looseObject({
  status: v.union([v.literal("accepted"), v.literal("already_applied")]),
  runId: v.string(), version: v.optional(v.number()), eventId: v.string()
});

export const setAgentRunArchivedReceiptSchema = v.looseObject({
  status: v.union([
    v.literal("archived"),
    v.literal("unarchived"),
    v.literal("unchanged")
  ]),
  run: v.looseObject({
    runId: v.string(),
    archivedAt: optionalString
  })
});

export type AgentRunStepOutput = v.InferOutput<typeof agentRunDetailViewSchema>["steps"][number];
export type AgentRunDecisionOutput = v.InferOutput<typeof agentRunDecisionSchema>;
export type AgentRunSummaryViewOutput = v.InferOutput<typeof agentRunSummarySchema>;
export type AgentRunDetailViewOutput = v.InferOutput<typeof agentRunDetailViewSchema>;
export type RunDetailViewOutput = v.InferOutput<typeof runDetailViewSchema>;
