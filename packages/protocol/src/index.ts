import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(255);
const timestampSchema = z.iso.datetime({ offset: true });
export const agentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

const principalReferenceSchema = z.object({
  kind: z.enum(["human", "device", "agent", "server"]),
  id: identifierSchema
}).strict();

export const eventEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  eventId: identifierSchema,
  type: identifierSchema,
  occurredAt: timestampSchema,
  traceId: identifierSchema.optional(),
  source: principalReferenceSchema,
  subject: principalReferenceSchema.optional(),
  payload: jsonValueSchema,
  adapter: z.object({
    transport: identifierSchema,
    metadata: z.record(z.string(), jsonValueSchema)
  }).strict().optional()
}).strict();

export const humanSchema = z.object({
  id: identifierSchema,
  oauthIssuer: z.url(),
  oauthSubject: identifierSchema,
  displayName: z.string().trim().min(1).max(255),
  status: z.enum(["active", "revoked"]),
  isAdmin: z.boolean(),
  createdAt: timestampSchema
}).strict();

export const deviceSchema = z.object({
  id: identifierSchema,
  humanId: identifierSchema,
  name: z.string().trim().min(1).max(255),
  status: z.enum(["pending", "active", "revoked"]),
  createdAt: timestampSchema,
  revokedAt: timestampSchema.optional()
}).strict();

export const agentSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(128),
  ownerHumanId: identifierSchema,
  status: z.enum(["provisioning", "active", "suspended", "revoked"]),
  createdAt: timestampSchema
}).strict();

export const placementSchema = z.object({
  id: identifierSchema,
  agentId: identifierSchema,
  deviceId: identifierSchema,
  state: z.enum(["pending", "active", "superseded", "revoked"]),
  generation: z.number().int().positive(),
  createdAt: timestampSchema,
  activatedAt: timestampSchema.optional()
}).strict();

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

export const pairingTransactionSchema = z.object({
  id: identifierSchema,
  deviceId: identifierSchema,
  verifierHash: z.string().min(32),
  status: z.enum(["pending", "approved", "redeemed", "expired", "cancelled"]),
  expiresAt: timestampSchema,
  approvedHumanId: identifierSchema.optional(),
  redeemedAt: timestampSchema.optional()
}).strict();

export const devicePairingCreateRequestSchema = z.object({
  deviceId: identifierSchema,
  deviceName: z.string().trim().min(1).max(255),
  verifierChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

export const devicePairingCreateResponseSchema = z.object({
  pairingId: identifierSchema,
  deviceId: identifierSchema,
  verificationUri: z.url(),
  userCode: z.string().min(1).max(256).optional(),
  expiresAt: timestampSchema,
  pollIntervalMilliseconds: z.number().int().min(100).max(60_000)
}).strict();

export const devicePairingStatusSchema = z.object({
  pairingId: identifierSchema,
  deviceId: identifierSchema,
  status: z.enum(["pending", "approved", "redeemed", "expired", "cancelled"]),
  expiresAt: timestampSchema,
  pollIntervalMilliseconds: z.number().int().min(100).max(60_000).optional()
}).strict();

export const devicePairingRedeemRequestSchema = z.object({
  deviceId: identifierSchema,
  verifier: z.string().min(32).max(512)
}).strict();

export const humanSummarySchema = humanSchema.pick({
  id: true,
  displayName: true,
  isAdmin: true
});

export const deviceSummarySchema = deviceSchema.pick({
  id: true,
  name: true,
  status: true,
  createdAt: true,
  revokedAt: true
}).extend({
  human: humanSummarySchema
}).strict();

export const deviceCredentialIssuanceSchema = z.object({
  credentialId: identifierSchema,
  credential: z.string().min(32),
  device: deviceSummarySchema
}).strict();

export const agentCreateRequestSchema = z.object({
  name: agentNameSchema,
  verifierChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

export const placementSummarySchema = placementSchema.pick({
  id: true,
  deviceId: true,
  state: true,
  generation: true,
  createdAt: true,
  activatedAt: true
});

export const agentSummarySchema = agentSchema.pick({
  id: true,
  name: true,
  status: true,
  createdAt: true
}).extend({
  owner: humanSummarySchema,
  operator: humanSummarySchema,
  placement: placementSummarySchema,
  credentialStatus: z.enum(["pending", "active", "revoked", "expired"])
}).strict();

export const agentEnrollmentSchema = z.object({
  id: identifierSchema,
  agentId: identifierSchema,
  deviceId: identifierSchema,
  placementId: identifierSchema,
  status: z.enum(["issued", "redeemed", "expired", "revoked"]),
  expiresAt: timestampSchema
}).strict();

export const agentCreateResponseSchema = z.object({
  agent: agentSummarySchema,
  enrollment: agentEnrollmentSchema
}).strict();

export const agentEnrollmentRedeemRequestSchema = z.object({
  verifier: z.string().min(32).max(512)
}).strict();

export const agentCredentialIssuanceSchema = z.object({
  credentialId: identifierSchema,
  credential: z.string().min(32),
  agent: agentSummarySchema
}).strict();

export const agentListSchema = z.array(agentSummarySchema);

export const enrollmentGrantSchema = z.object({
  id: identifierSchema,
  agentId: identifierSchema,
  deviceId: identifierSchema,
  placementId: identifierSchema,
  status: z.enum(["issued", "redeemed", "expired", "revoked"]),
  expiresAt: timestampSchema,
  redeemedAt: timestampSchema.optional()
}).strict();

export const credentialMetadataSchema = z.object({
  id: identifierSchema,
  principal: principalReferenceSchema,
  placementId: identifierSchema.optional(),
  status: z.enum(["active", "revoked", "expired"]),
  createdAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  rotatedFromCredentialId: identifierSchema.optional(),
  revokedAt: timestampSchema.optional()
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

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type Human = z.infer<typeof humanSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Placement = z.infer<typeof placementSchema>;
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
export type PairingTransaction = z.infer<typeof pairingTransactionSchema>;
export type DevicePairingCreateRequest = z.infer<typeof devicePairingCreateRequestSchema>;
export type DevicePairingCreateResponse = z.infer<typeof devicePairingCreateResponseSchema>;
export type DevicePairingStatus = z.infer<typeof devicePairingStatusSchema>;
export type DevicePairingRedeemRequest = z.infer<typeof devicePairingRedeemRequestSchema>;
export type HumanSummary = z.infer<typeof humanSummarySchema>;
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;
export type DeviceCredentialIssuance = z.infer<typeof deviceCredentialIssuanceSchema>;
export type AgentCreateRequest = z.infer<typeof agentCreateRequestSchema>;
export type PlacementSummary = z.infer<typeof placementSummarySchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type AgentEnrollment = z.infer<typeof agentEnrollmentSchema>;
export type AgentCreateResponse = z.infer<typeof agentCreateResponseSchema>;
export type AgentEnrollmentRedeemRequest = z.infer<
  typeof agentEnrollmentRedeemRequestSchema
>;
export type AgentCredentialIssuance = z.infer<typeof agentCredentialIssuanceSchema>;
export type EnrollmentGrant = z.infer<typeof enrollmentGrantSchema>;
export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>;
export type AttentionResult = z.infer<typeof attentionResultSchema>;
