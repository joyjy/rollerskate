import { z } from "zod";

import {
  eventEnvelopeSchema,
  identifierSchema,
  jsonValueSchema,
  timestampSchema
} from "./shared.js";

export const wakeModeSchema = z.enum(["disabled", "mention_only", "proactive"]);

export const agentRoomBindingSchema = z.object({
  id: identifierSchema,
  agentId: identifierSchema,
  roomId: identifierSchema,
  wakeMode: wakeModeSchema,
  status: z.enum(["active", "inactive"]),
  createdAt: timestampSchema
}).strict();

export const roomEventProjectionSchema = z.object({
  roomId: identifierSchema,
  position: z.string().trim().min(1).max(512),
  event: eventEnvelopeSchema,
  retainedUntil: timestampSchema.optional()
}).strict();

export const roomVisibilitySchema = z.enum(["public", "private"]);
export const roomCursorSchema = z.string().regex(/^r1\.[A-Za-z0-9_-]+$/);

export const roomCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  visibility: roomVisibilitySchema
}).strict();

export const roomMembershipSummarySchema = z.object({
  humanId: identifierSchema,
  role: z.enum(["owner", "member"]),
  canInvite: z.boolean(),
  status: z.enum(["invited", "active", "left"]),
  createdAt: timestampSchema
}).strict();

export const roomSummarySchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(255),
  matrixRoomId: identifierSchema,
  visibility: roomVisibilitySchema,
  head: roomCursorSchema,
  createdAt: timestampSchema,
  membership: roomMembershipSummarySchema.optional()
}).strict();

export const roomListSchema = z.array(roomSummarySchema);

export const agentRoomBindingSummarySchema = agentRoomBindingSchema.extend({
  createdByHumanId: identifierSchema,
  updatedAt: timestampSchema
}).strict();

export const agentRoomBindingListSchema = z.array(agentRoomBindingSummarySchema);

export const roomAgentInviteRequestSchema = z.object({
  agentId: identifierSchema
}).strict();

export const roomHumanInviteRequestSchema = z.object({
  humanId: identifierSchema
}).strict();

export const agentRoomWakeModeUpdateSchema = z.object({
  wakeMode: wakeModeSchema
}).strict();

export const roomHeadSchema = z.object({
  roomId: identifierSchema,
  head: roomCursorSchema
}).strict();

export const roomEventPageSchema = z.object({
  roomId: identifierSchema,
  through: roomCursorSchema,
  events: z.array(roomEventProjectionSchema).max(100),
  nextCursor: roomCursorSchema.optional(),
  complete: z.boolean()
}).strict();

export const roomStreamEventSchema = z.object({
  bindingId: identifierSchema,
  projection: roomEventProjectionSchema
}).strict();

export const roomMessageSendRequestSchema = z.object({
  transactionId: identifierSchema,
  body: z.string().min(1).max(65_536),
  causalChainId: identifierSchema.optional(),
  causalHop: z.number().int().min(1).max(1_000).optional()
}).strict().superRefine((value, context) => {
  if ((value.causalChainId === undefined) !== (value.causalHop === undefined)) {
    context.addIssue({
      code: "custom",
      message: "causalChainId and causalHop must be provided together"
    });
  }
});

export const roomMessageSendResponseSchema = z.object({
  eventId: identifierSchema,
  transactionId: identifierSchema
}).strict();

export const matrixApplicationServiceEventSchema = z.object({
  event_id: identifierSchema,
  room_id: identifierSchema,
  sender: identifierSchema,
  type: identifierSchema,
  origin_server_ts: z.number().int().nonnegative(),
  content: z.record(z.string(), jsonValueSchema)
}).passthrough();

export const matrixApplicationServiceTransactionSchema = z.object({
  events: z.array(matrixApplicationServiceEventSchema).max(1_000)
}).strict();

export const attentionResultSchema = z.object({
  id: identifierSchema,
  agentId: identifierSchema,
  roomId: identifierSchema,
  bindingId: identifierSchema,
  throughPosition: z.string().trim().min(1).max(512),
  decision: z.enum(["reply", "silent", "request_history", "compact"]),
  causalChainId: identifierSchema,
  causalHop: z.number().int().nonnegative(),
  createdAt: timestampSchema
}).strict();

export type AgentRoomBinding = z.infer<typeof agentRoomBindingSchema>;
export type RoomEventProjection = z.infer<typeof roomEventProjectionSchema>;
export type RoomVisibility = z.infer<typeof roomVisibilitySchema>;
export type RoomCursor = z.infer<typeof roomCursorSchema>;
export type RoomCreateRequest = z.infer<typeof roomCreateRequestSchema>;
export type RoomMembershipSummary = z.infer<typeof roomMembershipSummarySchema>;
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export type AgentRoomBindingSummary = z.infer<typeof agentRoomBindingSummarySchema>;
export type RoomAgentInviteRequest = z.infer<typeof roomAgentInviteRequestSchema>;
export type RoomHumanInviteRequest = z.infer<typeof roomHumanInviteRequestSchema>;
export type AgentRoomWakeModeUpdate = z.infer<typeof agentRoomWakeModeUpdateSchema>;
export type RoomHead = z.infer<typeof roomHeadSchema>;
export type RoomEventPage = z.infer<typeof roomEventPageSchema>;
export type RoomStreamEvent = z.infer<typeof roomStreamEventSchema>;
export type RoomMessageSendRequest = z.infer<typeof roomMessageSendRequestSchema>;
export type RoomMessageSendResponse = z.infer<typeof roomMessageSendResponseSchema>;
export type MatrixApplicationServiceEvent = z.infer<
  typeof matrixApplicationServiceEventSchema
>;
export type MatrixApplicationServiceTransaction = z.infer<
  typeof matrixApplicationServiceTransactionSchema
>;
export type AttentionResult = z.infer<typeof attentionResultSchema>;
