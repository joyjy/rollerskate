import * as v from "valibot";
import { runtimeAuditSchema } from "./event";
import { nullableString } from "./shared";

const operationAgentReferenceSchema = v.object({
  principalId: v.string(),
  handle: v.string(),
  client: v.string(),
  status: v.union([v.literal("active"), v.literal("suspended")])
});

const scheduledCallbackViewSchema = v.object({
  occurrenceId: v.string(),
  callbackId: v.string(),
  ordinal: v.number(),
  kind: v.union([
    v.literal("command.exec"), v.literal("agent.invoke"), v.literal("destination.deliver")
  ]),
  status: v.union([
    v.literal("pending"), v.literal("started"), v.literal("succeeded"),
    v.literal("blocked"), v.literal("failed"), v.literal("unknown")
  ]),
  phase: v.union([
    v.literal("pending"), v.literal("admitted"), v.literal("terminal"), v.literal("unknown")
  ]),
  eventId: nullableString,
  deliveryId: nullableString,
  receipt: v.nullable(v.unknown()),
  lastError: nullableString,
  startedAt: nullableString,
  completedAt: nullableString,
  delivery: v.nullable(v.object({
    status: v.union([
      v.literal("pending"), v.literal("delivering"), v.literal("retry_wait"),
      v.literal("delivered"), v.literal("failed")
    ]),
    attemptCount: v.number(),
    maxAttempts: v.number(),
    receipt: nullableString,
    lastError: nullableString
  }))
});

const scheduledRunViewSchema = v.object({
  runId: v.string(),
  scheduleId: v.string(),
  occurrenceKey: v.string(),
  scheduledFor: v.string(),
  scheduleRevision: v.number(),
  status: v.union([
    v.literal("queued"),
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("skipped"),
    v.literal("unknown")
  ]),
  statusReason: v.string(),
  eventId: nullableString,
  executionId: nullableString,
  sessionId: nullableString,
  decisionReason: nullableString,
  callbacks: v.array(scheduledCallbackViewSchema),
  availableActions: v.object({
    resolveSucceeded: v.boolean(),
    resolveFailed: v.boolean()
  }),
  failure: v.nullable(v.object({
    failureRef: v.string(),
    consoleRoute: v.string()
  })),
  createdAt: v.string(),
  updatedAt: v.string(),
  completedAt: nullableString,
  audit: v.nullable(runtimeAuditSchema)
});

export const scheduleSummaryViewSchema = v.object({
  scheduleId: v.string(),
  status: v.union([
    v.literal("active"),
    v.literal("paused"),
    v.literal("completed"),
    v.literal("cancelled")
  ]),
  statusReason: v.string(),
  currentRevision: v.number(),
  nextRunAt: nullableString,
  nextOccurrenceMissing: v.boolean(),
  kind: v.union([v.literal("once"), v.literal("cron")]),
  expression: v.string(),
  timezone: nullableString,
  sessionPolicy: v.union([
    v.literal("new_each_run"),
    v.literal("fixed")
  ]),
  fixedSessionId: nullableString,
  owner: operationAgentReferenceSchema,
  agent: operationAgentReferenceSchema,
  runCounts: v.object({
    queued: v.number(),
    running: v.number(),
    succeeded: v.number(),
    failed: v.number(),
    skipped: v.number(),
    unknown: v.number()
  }),
  availableActions: v.object({
    pause: v.boolean(),
    resume: v.boolean(),
    cancel: v.boolean(),
    runNow: v.boolean()
  }),
  updatedAt: v.string()
});

export const scheduleDetailViewSchema = v.object({
  summary: scheduleSummaryViewSchema,
  revision: v.object({
    revision: v.number(),
    misfirePolicy: v.union([v.literal("skip"), v.literal("run_once")]),
    overlapPolicy: v.union([v.literal("skip"), v.literal("queue")]),
    misfireGraceMilliseconds: v.number(),
    prompt: v.string(),
    workspace: v.string(),
    externalRefBinding: v.optional(v.nullable(v.unknown())),
    callbacks: v.array(v.looseObject({
      callbackId: v.string(),
      kind: v.union([
        v.literal("command.exec"), v.literal("agent.invoke"), v.literal("destination.deliver")
      ]),
      definition: v.unknown(),
      grant: v.unknown()
    })),
    createdAt: v.string()
  }),
  runs: v.array(scheduledRunViewSchema)
});

export const scheduleSummaryViewsSchema = v.array(scheduleSummaryViewSchema);
export const scheduleRunNowResponseSchema = v.object({
  receipt: v.looseObject({
    status: v.union([v.literal("accepted"), v.literal("duplicate")]),
    run: v.looseObject({
      runId: v.string(),
      status: v.string()
    })
  }),
  schedule: scheduleDetailViewSchema
});
export const scheduleResolveResponseSchema = v.object({
  run: scheduledRunViewSchema,
  schedule: scheduleDetailViewSchema
});

export type ScheduleSummaryViewOutput = v.InferOutput<typeof scheduleSummaryViewSchema>;
export type ScheduleDetailViewOutput = v.InferOutput<typeof scheduleDetailViewSchema>;
export type ScheduledRunViewOutput = v.InferOutput<typeof scheduledRunViewSchema>;
