import * as v from "valibot";
import {
  agentInvocationDiagnosticsSchema,
  agentStepResultSchema,
  agentTurnResultSchema
} from "./event";
import { nullableString, optionalString } from "./shared";

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

export const agentRunSummarySchema = v.object({
  runId: v.string(),
  rootEventId: v.string(),
  series: v.nullable(v.object({
    key: v.string(),
    activeCycleId: nullableString
  })),
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
  updatedAt: v.string()
});

const agentRunDetailViewInnerSchema = v.object({
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
  decisions: v.array(v.looseObject({
    schemaVersion: v.literal("AgentRunDecisionReceipt@1"),
    requestId: v.string(),
    expectedRunVersion: v.number(),
    resultingRunVersion: v.number(),
    sourceStepId: v.string(),
    action: v.union([
      v.literal("next_step"),
      v.literal("finish"),
      v.literal("needs_human")
    ]),
    acceptedAt: v.string()
  })),
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
    result: v.nullable(v.union([agentTurnResultSchema, agentStepResultSchema])),
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
export const agentRunSummariesSchema = v.array(agentRunSummarySchema);

export const cancelAgentRunReceiptSchema = v.looseObject({
  status: v.union([v.literal("cancelled"), v.literal("already_terminal")]),
  cancelledExecutions: v.number(),
  run: v.looseObject({
    runId: v.string(),
    status: agentRunStatusSchema
  })
});

export type AgentRunStepOutput = v.InferOutput<typeof agentRunDetailViewSchema>["steps"][number];
export type AgentRunSummaryViewOutput = v.InferOutput<typeof agentRunSummarySchema>;
export type AgentRunDetailViewOutput = v.InferOutput<typeof agentRunDetailViewSchema>;
