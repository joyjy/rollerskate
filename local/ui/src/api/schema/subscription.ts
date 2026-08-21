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

const freeSubscriptionSchema = v.object({
  kind: v.literal("free"),
  id: v.string(),
  title: v.string(),
  status: v.union([
    v.literal("active"), v.literal("paused"), v.literal("completed"),
    v.literal("blocked"), v.literal("cancelled"), v.literal("expired")
  ]),
  owner: subscriptionOwnerSchema,
  definition: v.object({
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
    callbacks: v.array(proactiveCallbackDefinitionSchema)
  }),
  callbacks: v.array(proactiveCallbackOccurrenceSchema),
  probe: subscriptionProbeSchema,
  schedule: subscriptionScheduleSchema,
  createdAt: v.string(),
  updatedAt: v.string(),
  latestError: nullableString,
  terminalObservation: v.unknown()
});

const continuousSubscriptionSchema = v.object({
  kind: v.literal("continuous"),
  id: v.string(),
  title: v.string(),
  status: v.union([
    v.literal("active"), v.literal("paused"), v.literal("blocked"), v.literal("cancelled")
  ]),
  owner: subscriptionOwnerSchema,
  definition: v.unknown(),
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
  latestError: nullableString,
  createdAt: v.string(),
  updatedAt: v.string()
});

export const subscriptionSchema = v.union([
  continuousSubscriptionSchema,
  freeSubscriptionSchema
]);

export const subscriptionsSchema = v.array(subscriptionSchema);

export type SubscriptionOutput = v.InferOutput<typeof subscriptionSchema>;
