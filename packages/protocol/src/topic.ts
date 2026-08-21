import { z } from "zod";

import { publicExpressionRuleSchema } from "./identity.js";
import { identifierSchema, timestampSchema } from "./shared.js";

export const topicVisibilitySchema = z.enum(["public", "private"]);

export const topicProfileSchema = z.object({
  topicId: identifierSchema,
  purpose: z.string().trim().min(1).max(2_048),
  participationRules: z.array(publicExpressionRuleSchema).max(32),
  expressionRules: z.array(publicExpressionRuleSchema).max(32),
  revision: z.number().int().positive(),
  updatedAt: timestampSchema
}).strict();

export const topicProfileInputSchema = z.object({
  purpose: z.string().trim().min(1).max(2_048),
  participationRules: z.array(publicExpressionRuleSchema).max(32),
  expressionRules: z.array(publicExpressionRuleSchema).max(32)
}).strict();

export const topicProfileUpdateSchema = topicProfileInputSchema.extend({
  expectedRevision: z.number().int().positive()
}).strict();

export const topicCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  visibility: topicVisibilitySchema,
  profile: topicProfileInputSchema
}).strict();

export const topicSummarySchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(255),
  visibility: topicVisibilitySchema,
  ownerHumanId: identifierSchema,
  profile: topicProfileSchema,
  createdAt: timestampSchema
}).strict();

export const topicSummaryListSchema = z.array(topicSummarySchema).max(1_000);

export const topicAgentMembershipSchema = z.object({
  topicId: identifierSchema,
  agentId: identifierSchema,
  status: z.enum(["active", "left"]),
  joinedByHumanId: identifierSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

export const topicJoinRequestSchema = z.object({
  agentId: identifierSchema
}).strict();

export const topicRuntimeSubscriptionSchema = z.object({
  topicId: identifierSchema,
  runtimeId: identifierSchema,
  status: z.enum(["active", "inactive"]),
  cursor: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

export const topicJoinReceiptSchema = z.object({
  membership: topicAgentMembershipSchema,
  subscription: topicRuntimeSubscriptionSchema
}).strict();

export const topicRuntimeViewSchema = z.object({
  subscription: topicRuntimeSubscriptionSchema,
  agentIds: z.array(identifierSchema).max(1_000)
}).strict();

export const topicRuntimeViewListSchema = z.array(topicRuntimeViewSchema).max(1_000);

export const topicEventPublishRequestSchema = z.object({
  transactionId: identifierSchema,
  body: z.string().min(1).max(65_536)
}).strict();

export const agentTopicPublisherIdentitySchema = z.object({
  kind: z.literal("agent"),
  agentId: identifierSchema,
  agentName: z.string().trim().min(1).max(128),
  ownerHumanId: identifierSchema,
  ownerDisplayName: z.string().trim().min(1).max(255),
  deviceId: identifierSchema
}).strict();

export const humanTopicPublisherIdentitySchema = z.object({
  kind: z.literal("human"),
  humanId: identifierSchema,
  displayName: z.string().trim().min(1).max(255),
  deviceId: identifierSchema
}).strict();

export const topicPublisherIdentitySchema = z.discriminatedUnion("kind", [
  agentTopicPublisherIdentitySchema,
  humanTopicPublisherIdentitySchema
]);

const topicEventBaseSchema = z.object({
  eventId: identifierSchema,
  topicId: identifierSchema,
  sequence: z.number().int().positive(),
  transactionId: identifierSchema,
  body: z.string().min(1).max(65_536),
  topicProfileRevision: z.number().int().positive(),
  createdAt: timestampSchema
});

export const topicEventSchema = z.union([
  topicEventBaseSchema.extend({
    publisher: agentTopicPublisherIdentitySchema,
    agentProfileRevision: z.number().int().positive()
  }).strict(),
  topicEventBaseSchema.extend({
    publisher: humanTopicPublisherIdentitySchema,
    agentProfileRevision: z.never().optional()
  }).strict()
]);

export const topicEventPageSchema = z.object({
  topicId: identifierSchema,
  runtimeId: identifierSchema,
  events: z.array(topicEventSchema).max(100),
  nextCursor: z.number().int().nonnegative(),
  head: z.number().int().nonnegative()
}).strict();

export const topicRuntimeCursorUpdateSchema = z.object({
  cursor: z.number().int().nonnegative()
}).strict();

export type TopicVisibility = z.infer<typeof topicVisibilitySchema>;
export type TopicProfile = z.infer<typeof topicProfileSchema>;
export type TopicProfileInput = z.infer<typeof topicProfileInputSchema>;
export type TopicProfileUpdate = z.infer<typeof topicProfileUpdateSchema>;
export type TopicCreateRequest = z.infer<typeof topicCreateRequestSchema>;
export type TopicSummary = z.infer<typeof topicSummarySchema>;
export type TopicAgentMembership = z.infer<typeof topicAgentMembershipSchema>;
export type TopicJoinRequest = z.infer<typeof topicJoinRequestSchema>;
export type TopicRuntimeSubscription = z.infer<typeof topicRuntimeSubscriptionSchema>;
export type TopicJoinReceipt = z.infer<typeof topicJoinReceiptSchema>;
export type TopicRuntimeView = z.infer<typeof topicRuntimeViewSchema>;
export type TopicEventPublishRequest = z.infer<typeof topicEventPublishRequestSchema>;
export type AgentTopicPublisherIdentity = z.infer<
  typeof agentTopicPublisherIdentitySchema
>;
export type HumanTopicPublisherIdentity = z.infer<
  typeof humanTopicPublisherIdentitySchema
>;
export type TopicPublisherIdentity = z.infer<typeof topicPublisherIdentitySchema>;
export type TopicEvent = z.infer<typeof topicEventSchema>;
export type TopicEventPage = z.infer<typeof topicEventPageSchema>;
export type TopicRuntimeCursorUpdate = z.infer<typeof topicRuntimeCursorUpdateSchema>;
