import * as v from "valibot";
import { nullableString } from "./shared";

const subscriptionOwnerSchema = v.object({
  agentId: v.string(),
  handle: v.string(),
  client: v.string()
});

const subscriptionProbeSchema = v.object({
  plugin: v.object({
    id: v.string(),
    path: v.string(),
    schemaVersion: v.number()
  }),
  policy: v.object({
    allowedHttpOrigins: v.array(v.string()),
    allowedExecutables: v.array(v.string()),
    allowedEnvironment: v.array(v.string()),
    timeoutMilliseconds: v.number(),
    maxOutputBytes: v.number()
  })
});

const subscriptionScheduleSchema = v.object({
  intervalMilliseconds: v.number(),
  maxWaitMilliseconds: v.number(),
  maxAttempts: v.number(),
  attemptCount: v.number(),
  deadlineAt: v.string(),
  nextPollAt: v.string()
});

const proactiveCallbackKindSchema = v.union([
  v.literal("command.exec"),
  v.literal("agent.invoke"),
  v.literal("destination.deliver")
]);

const proactiveCallbackDefinitionSchema = v.looseObject({
  callbackId: v.string(),
  kind: proactiveCallbackKindSchema,
  definition: v.unknown(),
  grant: v.unknown()
});

const subscriptionAgentResultSchema = v.object({
  schemaVersion: v.literal("SubscriptionAgentResult@1"),
  status: v.union([
    v.literal("succeeded"), v.literal("blocked"), v.literal("failed")
  ]),
  summary: v.string(),
  artifactRefs: v.array(v.string())
});

const runtimeExecutionStatusSchema = v.union([
  v.literal("queued"), v.literal("running"), v.literal("retry_wait"),
  v.literal("succeeded"), v.literal("failed"), v.literal("cancelled")
]);

const proactiveCallbackOccurrenceSchema = v.looseObject({
  occurrenceId: v.string(),
  callbackId: v.string(),
  ordinal: v.number(),
  kind: proactiveCallbackKindSchema,
  definition: v.unknown(),
  grant: v.unknown(),
  status: v.union([
    v.literal("pending"), v.literal("started"), v.literal("succeeded"),
    v.literal("blocked"), v.literal("failed"), v.literal("unknown")
  ]),
  invocationStatus: v.optional(v.nullable(runtimeExecutionStatusSchema)),
  agentResult: v.optional(v.nullable(subscriptionAgentResultSchema)),
  receipt: v.optional(v.unknown()),
  lastError: v.optional(v.string())
});

const archiveActionsSchema = v.object({
  archive: v.boolean(),
  unarchive: v.boolean()
});

const subscriptionAdmissionReceiptSchema = v.object({
  schemaVersion: v.literal("SubscriptionOccurrenceAdmissionReceipt@1"),
  subscriptionId: v.string(),
  occurrenceKey: v.string(),
  agentRunId: v.string(),
  cycleId: v.string(),
  orchestratorEventId: v.string(),
  orchestratorExecutionId: v.string(),
  admittedAt: v.string()
});

const legacyFreeDefinitionSchema = v.object({
  schema: v.literal("SubscriptionDefinition@3"),
  revision: v.string(),
  digest: v.string(),
  callbackPhaseStatus: v.union([
    v.literal("pending"), v.literal("running"), v.literal("completed"),
    v.literal("completed_with_errors"), v.literal("completed_with_unknown"),
    v.literal("blocked")
  ]),
  artifactRevision: v.string(),
  artifactDigest: v.string(),
  externalRefBinding: v.optional(v.nullable(v.unknown())),
  callbacks: v.array(proactiveCallbackDefinitionSchema),
  sourceBinding: v.optional(v.nullable(v.unknown()))
});

const boundFreeDefinitionSchema = v.object({
  schema: v.literal("SubscriptionDefinition@4"),
  revision: v.string(),
  digest: v.string(),
  callbackPhaseStatus: v.union([
    v.literal("pending"), v.literal("running"), v.literal("completed"),
    v.literal("completed_with_errors"), v.literal("completed_with_unknown"),
    v.literal("blocked")
  ]),
  artifactRevision: v.string(),
  artifactDigest: v.string(),
  externalRefBinding: v.optional(v.nullable(v.unknown())),
  callbacks: v.array(proactiveCallbackDefinitionSchema),
  sourceBinding: v.unknown()
});

const freeSubscriptionSchema = v.object({
  kind: v.literal("free"),
  id: v.string(),
  title: v.string(),
  status: v.union([
    v.literal("active"), v.literal("paused"), v.literal("completed"),
    v.literal("blocked"), v.literal("cancelled"), v.literal("expired")
  ]),
  owner: v.nullable(subscriptionOwnerSchema),
  definition: v.union([legacyFreeDefinitionSchema, boundFreeDefinitionSchema]),
  callbacks: v.array(proactiveCallbackOccurrenceSchema),
  probe: subscriptionProbeSchema,
  schedule: subscriptionScheduleSchema,
  createdAt: v.string(),
  updatedAt: v.string(),
  latestError: nullableString,
  terminalObservation: v.unknown(),
  agentRunId: v.optional(nullableString),
  cycleId: v.optional(nullableString),
  admissionReceipt: v.optional(v.nullable(subscriptionAdmissionReceiptSchema)),
  archivedAt: nullableString,
  availableActions: archiveActionsSchema
});

const continuousSubscriptionSchema = v.object({
  kind: v.literal("continuous"),
  id: v.string(),
  title: v.string(),
  status: v.union([
    v.literal("active"), v.literal("paused"), v.literal("blocked"), v.literal("cancelled")
  ]),
  owner: v.nullable(subscriptionOwnerSchema),
  definition: v.union([
    v.looseObject({
      schemaVersion: v.literal("ContinuousSubscriptionDefinition@1"),
      revision: v.number()
    }),
    v.looseObject({
      schemaVersion: v.literal("ContinuousSubscriptionDefinition@2"),
      revision: v.number(),
      sourceBinding: v.unknown()
    })
  ]),
  callbacks: v.array(proactiveCallbackOccurrenceSchema),
  callbackOccurrenceKey: nullableString,
  callbackSummary: v.object({
    total: v.number(),
    pending: v.number(),
    started: v.number(),
    terminal: v.number(),
    unknown: v.number()
  }),
  probe: subscriptionProbeSchema,
  pollCount: v.number(),
  nextPollAt: v.string(),
  checkpointOccurrenceKey: nullableString,
  checkpointObservation: v.unknown(),
  pendingOccurrenceKey: nullableString,
  pendingObservation: v.unknown(),
  agentRunId: v.optional(nullableString),
  pendingCycleId: v.optional(nullableString),
  pendingAdmissionReceipt: v.optional(v.nullable(subscriptionAdmissionReceiptSchema)),
  latestError: nullableString,
  archivedAt: nullableString,
  availableActions: archiveActionsSchema,
  createdAt: v.string(),
  updatedAt: v.string()
});

export const subscriptionSchema = v.union([
  continuousSubscriptionSchema,
  freeSubscriptionSchema
]);

export const subscriptionsSchema = v.object({
  items: v.array(subscriptionSchema),
  total: v.number(),
  page: v.number(),
  pageSize: v.number()
});

export const subscriptionArchiveResponseSchema = v.object({
  subscription: subscriptionSchema,
  status: v.union([v.literal("archive"), v.literal("unarchive")])
});

export type SubscriptionOutput = v.InferOutput<typeof subscriptionSchema>;
