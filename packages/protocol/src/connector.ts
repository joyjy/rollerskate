import { z } from "zod";

import {
  identifierSchema,
  jsonValueSchema,
  timestampSchema
} from "./shared.js";

export const integrationBindingSchema = z.object({
  schemaVersion: z.literal("IntegrationBinding@1"),
  bindingId: identifierSchema,
  ownerHumanId: identifierSchema,
  connectorId: identifierSchema,
  connectorVersion: identifierSchema,
  placement: z.enum(["server", "runtime"]),
  endpointRef: z.string().trim().min(1).max(2_048),
  profileIds: z.array(identifierSchema).min(1).max(16),
  externalScopeRef: z.string().trim().min(1).max(1_024),
  credentialRef: z.string().trim().min(1).max(1_024),
  cursor: z.string().max(1_024).optional(),
  status: z.enum(["active", "suspended", "revoked"]),
  revision: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

export const integrationBindingCreateRequestSchema = integrationBindingSchema.pick({
  connectorId: true,
  connectorVersion: true,
  placement: true,
  endpointRef: true,
  profileIds: true,
  externalScopeRef: true,
  credentialRef: true
}).strict();

export const integrationBindingUpdateRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  cursor: z.string().max(1_024).nullable().optional(),
  status: z.enum(["active", "suspended", "revoked"]).optional()
}).strict().refine(
  (value) => value.cursor !== undefined || value.status !== undefined,
  "Integration binding update requires cursor or status"
);

export const externalRefSchema = z.object({
  schemaVersion: z.literal("ExternalRef@1"),
  integrationBindingId: identifierSchema,
  kind: identifierSchema,
  externalId: z.string().trim().min(1).max(1_024),
  revision: z.string().trim().min(1).max(512).optional()
}).strict();

const boundedJsonSchema = jsonValueSchema.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65_536,
  "JSON payload exceeds 65536 bytes"
);

export const observationSchema = z.object({
  schemaVersion: z.literal("Observation@1"),
  observationId: identifierSchema,
  sourceRef: externalRefSchema,
  sourceRevision: z.string().trim().min(1).max(512),
  profileId: identifierSchema,
  schemaRef: identifierSchema,
  boundedPayload: boundedJsonSchema,
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  occurredAt: timestampSchema,
  cursor: z.string().max(1_024)
}).strict();

export const connectorProfileSchema = z.object({
  profileId: identifierSchema,
  readSchemaRefs: z.array(identifierSchema).max(32)
}).strict();

export const connectorDescribeRequestSchema = z.object({
  schemaVersion: z.literal("ConnectorDescribeRequest@1")
}).strict();

export const connectorDescriptionSchema = z.object({
  schemaVersion: z.literal("ConnectorDescription@1"),
  connectorId: identifierSchema,
  connectorVersion: identifierSchema,
  profiles: z.array(connectorProfileSchema).min(1).max(16)
}).strict();

export const connectorObserveRequestSchema = z.object({
  schemaVersion: z.literal("ConnectorObserveRequest@1"),
  integrationBindingId: identifierSchema,
  cursor: z.string().max(1_024).optional(),
  limit: z.number().int().min(1).max(100)
}).strict();

export const connectorObservationPageSchema = z.object({
  schemaVersion: z.literal("ConnectorObservationPage@1"),
  observations: z.array(observationSchema).max(100),
  nextCursor: z.string().max(1_024),
  complete: z.boolean()
}).strict();

export const connectorReadRequestSchema = z.object({
  schemaVersion: z.literal("ConnectorReadRequest@1"),
  ref: externalRefSchema,
  profileId: identifierSchema,
  schemaRef: identifierSchema,
  maxBytes: z.number().int().min(1).max(65_536)
}).strict();

export const connectorReadResultSchema = z.object({
  schemaVersion: z.literal("ConnectorReadResult@1"),
  ref: externalRefSchema,
  profileId: identifierSchema,
  schemaRef: identifierSchema,
  boundedPayload: boundedJsonSchema,
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  readAt: timestampSchema
}).strict();

export type IntegrationBinding = z.infer<typeof integrationBindingSchema>;
export type IntegrationBindingCreateRequest = z.infer<
  typeof integrationBindingCreateRequestSchema
>;
export type IntegrationBindingUpdateRequest = z.infer<
  typeof integrationBindingUpdateRequestSchema
>;
export type ExternalRef = z.infer<typeof externalRefSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type ConnectorProfile = z.infer<typeof connectorProfileSchema>;
export type ConnectorDescribeRequest = z.infer<typeof connectorDescribeRequestSchema>;
export type ConnectorDescription = z.infer<typeof connectorDescriptionSchema>;
export type ConnectorObserveRequest = z.infer<typeof connectorObserveRequestSchema>;
export type ConnectorObservationPage = z.infer<typeof connectorObservationPageSchema>;
export type ConnectorReadRequest = z.infer<typeof connectorReadRequestSchema>;
export type ConnectorReadResult = z.infer<typeof connectorReadResultSchema>;
