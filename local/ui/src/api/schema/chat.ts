import * as v from "valibot";
import { localAgentSchema } from "./local";
import { chatPresenceSchema, runtimeEventSchema } from "./event";
import { optionalString } from "./shared";

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
      }))
    })),
    hasEarlier: v.boolean(),
    beforeEventId: optionalString
  }),
  sessions: v.array(v.object({
    principalId: v.string(),
    currentSessionId: optionalString,
    generation: v.number()
  })),
  conversation: v.object({
    strategy: v.literal("starter"),
    state: v.union([
      v.literal("starter_pending"),
      v.literal("active"),
      v.literal("all_silent"),
      v.literal("budget_exhausted"),
      v.literal("idle")
    ]),
    turnBudget: v.number(),
    usedTurns: v.number(),
    remainingTurns: v.number(),
    latestReason: optionalString,
    activeSpeakerHandle: optionalString,
    activeSpeakerHandles: v.array(v.string())
  })
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
