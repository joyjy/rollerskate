import { z } from "zod";

import {
  identifierSchema,
  principalReferenceSchema,
  timestampSchema
} from "./shared.js";

export const agentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

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

export const agentCredentialRevocationSchema = z.object({
  agentId: identifierSchema,
  revokedCount: z.number().int().nonnegative(),
  revokedAt: timestampSchema
}).strict();

export const agentListSchema = z.array(agentSummarySchema);

export const publicExpressionRuleSchema = z.string().trim().min(1).max(1_024);

export const agentPublicProfileSchema = z.object({
  agentId: identifierSchema,
  displayName: z.string().trim().min(1).max(128),
  role: z.string().trim().min(1).max(512),
  disclosure: z.string().trim().min(1).max(2_048),
  expressionRules: z.array(publicExpressionRuleSchema).max(32),
  revision: z.number().int().positive(),
  updatedAt: timestampSchema
}).strict();

export const agentPublicProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(128),
  role: z.string().trim().min(1).max(512),
  disclosure: z.string().trim().min(1).max(2_048),
  expressionRules: z.array(publicExpressionRuleSchema).max(32),
  expectedRevision: z.number().int().nonnegative()
}).strict();

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

export type Human = z.infer<typeof humanSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Placement = z.infer<typeof placementSchema>;
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
export type AgentCredentialRevocation = z.infer<typeof agentCredentialRevocationSchema>;
export type AgentPublicProfile = z.infer<typeof agentPublicProfileSchema>;
export type AgentPublicProfileUpdate = z.infer<typeof agentPublicProfileUpdateSchema>;
export type EnrollmentGrant = z.infer<typeof enrollmentGrantSchema>;
export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>;
