import * as v from "valibot";

export const runtimeInfoSchema = v.object({
  status: v.union([
    v.literal("running"),
    v.literal("paused"),
    v.literal("degraded"),
    v.literal("stopped")
  ]),
  statusReason: v.string(),
  recommendedAction: v.string(),
  statusSince: v.string(),
  version: v.string(),
  runtimeRoot: v.string(),
  workspaceRoot: v.string(),
  pid: v.nullable(v.number()),
  startedAt: v.nullable(v.string()),
  schemaVersion: v.nullable(v.number()),
  runtimeRevision: v.object({
    expected: v.string(),
    running: v.nullable(v.string()),
    matchesExpected: v.boolean()
  }),
  consoleAddress: v.string(),
  lastRefreshedAt: v.string(),
  stale: v.boolean(),
  loop: v.object({
    phase: v.union([v.literal("idle"), v.literal("in_cycle")]),
    totalCycles: v.number(),
    lastCycleStartAt: v.nullable(v.string()),
    lastCycleEndAt: v.nullable(v.string()),
    lastCycleDurationMs: v.nullable(v.number()),
    currentPhaseSummary: v.nullable(v.string())
  }),
  controls: v.object({
    pause: v.boolean(),
    resume: v.boolean(),
    recover: v.boolean()
  }),
  workload: v.object({
    state: v.union([
      v.literal("idle"),
      v.literal("running"),
      v.literal("queued"),
      v.literal("retrying")
    ]),
    ready: v.number(),
    running: v.number(),
    retrying: v.number(),
    total: v.number(),
    asOf: v.string()
  }),
  failures: v.array(v.object({
    failureRef: v.string(),
    owner: v.union([
      v.literal("runtime"),
      v.literal("agent"),
      v.literal("event"),
      v.literal("chat"),
      v.literal("subscription"),
      v.literal("schedule"),
      v.literal("notice")
    ]),
    severity: v.union([v.literal("warning"), v.literal("error")]),
    reason: v.string(),
    objectRef: v.string(),
    eventId: v.optional(v.string()),
    relatedRef: v.optional(v.string()),
    occurredAt: v.string(),
    action: v.object({
      kind: v.union([
        v.literal("inspect"),
        v.literal("recover"),
        v.literal("reconcile"),
        v.literal("configure")
      ]),
      available: v.boolean(),
      consoleRoute: v.optional(v.string()),
      cliHint: v.string()
    })
  })),
  controlResult: v.nullable(v.object({
    kind: v.union([
      v.literal("pause"),
      v.literal("resume"),
      v.literal("recover")
    ]),
    status: v.union([v.literal("succeeded"), v.literal("failed")]),
    message: v.string(),
    recovered: v.optional(v.number()),
    leftUnknown: v.optional(v.number()),
    failed: v.optional(v.number())
  }))
});

export type RuntimeInfoOutput = v.InferOutput<typeof runtimeInfoSchema>;
export type RuntimeFailureOutput = RuntimeInfoOutput["failures"][number];
