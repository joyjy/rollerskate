import * as v from "valibot";
import { localAgentSchema } from "./local";
import { chatPresenceSchema, runtimeEventSchema } from "./event";
import { optionalString, runHumanQuestionSchema } from "./shared";

export const chatWorkViewSchema = v.object({
    humanQuestion:v.optional(v.nullable(runHumanQuestionSchema)),
    runId: v.string(),
    label: optionalString,
    version: v.optional(v.number()),
    state: v.union([
      v.literal("started"),
      v.literal("needs_human"),
      v.literal("terminal")
    ]),
    status: v.union([
      v.literal("active"),
      v.literal("waiting"),
      v.literal("awaiting_orchestrator"),
      v.literal("awaiting_source"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("needs_human"),
      v.literal("cancelled")
    ]),
    terminal: v.optional(v.boolean()),
    attentionReason: optionalString,
    outputs: v.optional(v.array(v.object({
      outputId: v.string(), stepId: v.string(), title: v.string(),
      kind: v.string(), contentType: v.string()
    }))),
    outputsTruncated: v.optional(v.boolean()),
    terminalSummary: optionalString,
    updatedAt: v.string()
  });

export const chatRunProposalDraftSchema = v.object({
  schema: v.literal("ChatRunProposalDraft@1"),
  goal: optionalString,
  scope: v.object({
    include: v.array(v.string()),
    exclude: v.array(v.string())
  }),
  acceptance: v.array(v.string()),
  desiredEffect: v.optional(v.union([
    v.literal("none"),
    v.literal("read"),
    v.literal("change")
  ])),
  workspaceRef: v.optional(v.literal("local:workspace")),
  blockingQuestion: optionalString
});

export const chatRunProposalViewSchema = v.object({
  schema: v.literal("ChatRunProposalView@2"),
  proposalId: v.string(),
  revision: v.string(),
  sourceMessageEventId: v.string(),
  sourceRootEventId: v.string(),
  dispatchEventId: v.string(),
  createdAt: v.string(),
  chatLead: v.object({ agentId: v.string(), handle: v.string() }),
  finalForm: chatRunProposalDraftSchema,
  ready: v.boolean(),
  blocker: v.optional(v.object({
    code: v.union([
      v.literal("workspace_required"),
      v.literal("workspace_invalid"),
      v.literal("clarification_required"),
      v.literal("steward_unavailable"),
      v.literal("admission_failed")
    ]),
    message: v.string(),
    action: v.union([
      v.literal("choose_workspace"),
      v.literal("reply"),
      v.literal("inspect_agents"),
      v.literal("inspect_runtime")
    ]),
    detail: optionalString
  })),
  workspaceChoices: v.optional(v.array(v.object({
    kind: v.union([v.literal("project"), v.literal("local"), v.literal("path")]),
    label: v.string(),
    root: optionalString
  }))),
  selectedWorkspace: v.optional(v.object({
    kind: v.union([v.literal("project"), v.literal("local"), v.literal("path")]),
    root: v.string()
  })),
  runOrchestrator: v.optional(v.object({ agentId: v.string(), handle: v.string() })),
  participants: v.array(v.object({ agentId: v.string(), handle: v.string() })),
  authority: v.optional(v.object({
    summary: v.string(),
    workspace: v.optional(v.object({
      root: v.string(),
      revision: v.string(),
      access: v.union([v.literal("read"), v.literal("write")]),
      effect: v.optional(v.union([
        v.literal("must_change"),
        v.literal("may_remain_unchanged")
      ])),
      networkAccess: v.boolean()
    })),
    maxSteps: v.number(),
    maxDepth: v.number()
  })),
  linkedRun: v.optional(chatWorkViewSchema),
  decision: v.optional(v.object({
    status: v.literal("declined"),
    eventId: v.string(),
    actorPrincipalId: v.string(),
    decidedAt: v.string()
  }))
});

export const chatRunProposalPreflightSchema = v.object({
  schema: v.literal("ChatRunProposalPreflight@1"),
  sourceRevision: v.string(),
  proposal: chatRunProposalViewSchema
});

export const chatRunProposalDecisionReceiptSchema = v.object({
  schema: v.literal("ChatRunProposalDecisionReceipt@1"),
  status: v.union([v.literal("declined"), v.literal("duplicate")]),
  proposal: chatRunProposalViewSchema
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
      replyToEventId: optionalString,
      targets: v.optional(v.array(v.object({
        principalId: v.string(),
        handleSnapshot: v.string()
      }))),
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
      })),
      works: v.optional(v.array(chatWorkViewSchema)),
      runProposals: v.optional(v.array(chatRunProposalViewSchema))
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
    topic: v.optional(chatPresenceSchema),
    clientHistory: v.optional(v.object({
      client: v.string(),
      status: v.union([v.literal("active"), v.literal("revoked")]),
      updatedAt: v.string(),
      coverage: v.union([
        v.literal("not_checked"),
        v.literal("available"),
        v.literal("unavailable"),
        v.literal("unsupported"),
        v.literal("error")
      ]),
      lastUsedAt: optionalString,
      lastResultCount: v.optional(v.number()),
      truncated: v.optional(v.boolean())
    })),
    lastTurn: v.optional(v.object({
      state: v.union([
        v.literal("thinking"),
        v.literal("replied"),
        v.literal("proposed"),
        v.literal("silent"),
        v.literal("failed")
      ]),
      at: v.string(),
      reason: optionalString
    }))
  }))
});

export type LocalChatViewOutput = v.InferOutput<typeof localChatViewSchema>;
export type LocalChatPresenceViewOutput = v.InferOutput<typeof localChatPresenceViewSchema>;
