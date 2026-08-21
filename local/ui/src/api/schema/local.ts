import * as v from "valibot";
import { optionalString } from "./shared";

export const localAgentSchema = v.object({
  principalId: v.string(),
  handle: v.string(),
  status: v.union([v.literal("active"), v.literal("suspended")]),
  client: v.string(),
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

export const agentSummarySchema = v.object({
  principalId: v.string(),
  handle: v.string(),
  status: v.union([v.literal("active"), v.literal("suspended")]),
  client: v.string(),
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

export const agentSummariesSchema = v.array(agentSummarySchema);

export const agentMutationResponseSchema = v.looseObject({
  error: optionalString,
  principalId: optionalString
});

export type LocalSnapshotOutput = v.InferOutput<typeof localSnapshotSchema>;
export type LocalAgentOutput = v.InferOutput<typeof localAgentSchema>;
export type LocalFoundationOutput = v.InferOutput<typeof localFoundationSchema>;
export type AgentSummaryOutput = v.InferOutput<typeof agentSummarySchema>;
