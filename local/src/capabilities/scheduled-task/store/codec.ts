import { isAbsolute } from "node:path";

import { requireLocalId } from "../../../core/id.js";
import { requireRuntimeId } from "../../../core/runtime/model.js";
import {
  requireAgentRunCycleId,
  requireAgentRunId
} from "../../../modules/steward/state-machine.js";
import type { ProactiveCallbackDefinition } from "../../../modules/callback/proactive-model.js";
import {
  parseRunSourceBinding,
  type RunSourceBinding
} from "../../../modules/steward/source-contract.js";
import {
  parseProactiveTarget,
  type ProactiveTarget
} from "../../../modules/proactive/target.js";
import {
  decodeExternalRefTriggerBinding,
  parseExternalRefTriggerBinding
} from "../../../modules/external-resource/trigger-binding.js";
import {
  requireScheduleId,
  requireScheduleRevision,
  requireScheduledRunId,
  type BoundScheduleRevision,
  type CreateBoundScheduleInput,
  type CreateTargetedScheduleInput,
  type LegacyScheduleRevision,
  type ScheduleOccurrenceAdmissionReceipt,
  type ScheduledRun,
  type ScheduledRunStatus,
  type ScheduleDefinition,
  type ScheduleRevision,
  type ScheduleRevisionInput,
  type ScheduleStatus,
  type TargetedScheduleRevision
} from "../model.js";
import {
  canonicalCronExpression,
  canonicalOnceExpression,
  nextCronOccurrence,
  requireIanaTimezone,
  type ScheduledOccurrence
} from "../time.js";

export interface DefinitionRow {
  schedule_id: string;
  owner_principal_id: string;
  status: ScheduleStatus;
  current_revision: number;
  next_run_at: string | null;
  next_occurrence_key: string | null;
  next_occurrence_missing: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RevisionRow {
  schedule_id: string;
  revision: number;
  definition_schema: "ScheduleRevision@1" | "ScheduleRevision@2" | "ScheduleRevision@3";
  agent_id: string | null;
  kind: ScheduleRevision["kind"];
  expression: string;
  expression_version: ScheduleRevision["expressionVersion"];
  timezone: string | null;
  misfire_policy: ScheduleRevision["misfirePolicy"];
  overlap_policy: ScheduleRevision["overlapPolicy"];
  misfire_grace_ms: number;
  session_policy: LegacyScheduleRevision["sessionPolicy"] | null;
  fixed_session_id: string | null;
  prompt: string | null;
  workspace: string | null;
  source_binding_json: string | null;
  target_json: string | null;
  external_ref_binding_json: string | null;
  created_at: string;
}

export interface RunRow {
  run_id: string;
  schedule_id: string;
  occurrence_key: string;
  scheduled_for: string;
  schedule_revision: number;
  definition_snapshot_json: string;
  coalesced_through: string | null;
  admitted_at: string | null;
  status: ScheduledRunStatus;
  event_id: string | null;
  execution_id: string | null;
  session_id: string | null;
  agent_run_id: string | null;
  cycle_id: string | null;
  admission_receipt_json: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function normalizeRevision(
  scheduleId: string,
  revision: number,
  input: ScheduleRevisionInput,
  createdAt: string
): LegacyScheduleRevision {
  requireScheduleId(scheduleId);
  requireScheduleRevision(revision);
  requireLocalId(input.agentId, "prn", "agentId");
  const expression = input.kind === "once"
    ? canonicalOnceExpression(input.expression)
    : canonicalCronExpression(input.expression);
  const timezone = input.kind === "cron"
    ? requireIanaTimezone(input.timezone ?? "")
    : undefined;
  if (input.kind === "once" && input.timezone !== undefined) {
    throw new Error("once schedule must not define timezone");
  }
  if (!["skip", "run_once"].includes(input.misfirePolicy)) {
    throw new Error(`unsupported misfire policy: ${input.misfirePolicy}`);
  }
  if (!["skip", "queue"].includes(input.overlapPolicy)) {
    throw new Error(`unsupported overlap policy: ${input.overlapPolicy}`);
  }
  bounded(input.misfireGraceMilliseconds, 0, 604_800_000, "misfireGraceMilliseconds");
  if (!["new_each_run", "fixed"].includes(input.sessionPolicy)) {
    throw new Error(`unsupported session policy: ${input.sessionPolicy}`);
  }
  if (input.sessionPolicy === "fixed") {
    if (input.fixedSessionId === undefined) {
      throw new Error("fixed session policy requires fixedSessionId");
    }
    requireRuntimeId(input.fixedSessionId, "ses", "fixedSessionId");
  } else if (input.fixedSessionId !== undefined) {
    throw new Error("new_each_run session policy must not define fixedSessionId");
  }
  text(input.prompt, "prompt", 64_000);
  text(input.workspace, "workspace", 4_096);
  if (!isAbsolute(input.workspace)) throw new Error("workspace must be an absolute path");
  const callbacks = input.callbacks === undefined
    ? [legacyAgentCallback(input)]
    : [...input.callbacks];
  const externalRefBinding = input.externalRefBinding === undefined
    ? undefined
    : parseExternalRefTriggerBinding(input.externalRefBinding);
  if (callbacks.length === 0) throw new Error("Schedule callbacks must not be empty");
  return {
    schemaVersion: "ScheduleRevision@1",
    scheduleId,
    revision,
    agentId: input.agentId,
    kind: input.kind,
    expression,
    expressionVersion: input.kind === "once" ? "once-rfc3339-v1" : "cron-v1",
    ...(timezone === undefined ? {} : { timezone }),
    misfirePolicy: input.misfirePolicy,
    overlapPolicy: input.overlapPolicy,
    misfireGraceMilliseconds: input.misfireGraceMilliseconds,
    sessionPolicy: input.sessionPolicy,
    ...(input.fixedSessionId === undefined ? {} : { fixedSessionId: input.fixedSessionId }),
    prompt: input.prompt,
    workspace: input.workspace,
    callbacks,
    ...(externalRefBinding === undefined ? {} : { externalRefBinding }),
    createdAt
  };
}

export function normalizeBoundRevision(
  input: CreateBoundScheduleInput,
  createdAt: string
): BoundScheduleRevision {
  requireScheduleId(input.scheduleId);
  const expression = input.kind === "once"
    ? canonicalOnceExpression(input.expression)
    : canonicalCronExpression(input.expression);
  const timezone = input.kind === "cron"
    ? requireIanaTimezone(input.timezone ?? "")
    : undefined;
  if (input.kind === "once" && input.timezone !== undefined) {
    throw new Error("once schedule must not define timezone");
  }
  if (input.misfirePolicy !== "skip" && input.misfirePolicy !== "run_once") {
    throw new Error(`unsupported misfire policy: ${input.misfirePolicy}`);
  }
  if (input.overlapPolicy !== "skip" && input.overlapPolicy !== "queue") {
    throw new Error(`unsupported overlap policy: ${input.overlapPolicy}`);
  }
  const sourceBinding = requireScheduleSourceBinding(input.sourceBinding);
  if (sourceBinding.source.id !== input.scheduleId ||
    sourceBinding.source.definitionRevision !== "ScheduleRevision@2:1" ||
    sourceBinding.occurrencePolicy !== (input.kind === "once" ? "one_shot" : "recurring")) {
    throw new Error("ScheduleRevision@2 source binding does not match its definition");
  }
  return {
    schemaVersion: "ScheduleRevision@2",
    scheduleId: input.scheduleId,
    revision: 1,
    kind: input.kind,
    expression,
    expressionVersion: input.kind === "once" ? "once-rfc3339-v1" : "cron-v1",
    ...(timezone === undefined ? {} : { timezone }),
    misfirePolicy: input.misfirePolicy,
    overlapPolicy: input.overlapPolicy,
    misfireGraceMilliseconds: bounded(
      input.misfireGraceMilliseconds,
      0,
      604_800_000,
      "misfireGraceMilliseconds"
    ),
    sourceBinding,
    ...(input.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: parseExternalRefTriggerBinding(input.externalRefBinding) }),
    createdAt: iso(createdAt, "createdAt")
  };
}

export function normalizeTargetedRevision(
  input: CreateTargetedScheduleInput,
  createdAt: string
): TargetedScheduleRevision {
  requireScheduleId(input.scheduleId);
  const expression = input.kind === "once"
    ? canonicalOnceExpression(input.expression)
    : canonicalCronExpression(input.expression);
  const timezone = input.kind === "cron"
    ? requireIanaTimezone(input.timezone ?? "")
    : undefined;
  if (input.kind === "once" && input.timezone !== undefined) {
    throw new Error("once schedule must not define timezone");
  }
  if (input.misfirePolicy !== "skip" && input.misfirePolicy !== "run_once") {
    throw new Error(`unsupported misfire policy: ${input.misfirePolicy}`);
  }
  if (input.overlapPolicy !== "skip" && input.overlapPolicy !== "queue") {
    throw new Error(`unsupported overlap policy: ${input.overlapPolicy}`);
  }
  const expectedSource = {
    kind: "schedule" as const,
    id: input.scheduleId,
    definitionRevision: "ScheduleRevision@3:1"
  };
  const target = parseProactiveTarget(input.target, expectedSource);
  if (target.kind === "steward_run" &&
    target.sourceBinding.occurrencePolicy !== (input.kind === "once" ? "one_shot" : "recurring")) {
    throw new Error("ScheduleRevision@3 target occurrence policy does not match its definition");
  }
  return {
    schemaVersion: "ScheduleRevision@3",
    scheduleId: input.scheduleId,
    revision: 1,
    kind: input.kind,
    expression,
    expressionVersion: input.kind === "once" ? "once-rfc3339-v1" : "cron-v1",
    ...(timezone === undefined ? {} : { timezone }),
    misfirePolicy: input.misfirePolicy,
    overlapPolicy: input.overlapPolicy,
    misfireGraceMilliseconds: bounded(
      input.misfireGraceMilliseconds, 0, 604_800_000, "misfireGraceMilliseconds"
    ),
    target,
    ...(input.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: parseExternalRefTriggerBinding(input.externalRefBinding) }),
    createdAt: iso(createdAt, "createdAt")
  };
}

function legacyAgentCallback(input: ScheduleRevisionInput): ProactiveCallbackDefinition {
  return {
    callbackId: "agent",
    kind: "agent.invoke",
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1",
      callbackId: "agent",
      kind: "agent.invoke",
      agentId: input.agentId,
      workspace: input.workspace,
      prompt: input.prompt,
      ...(input.fixedSessionId === undefined ? {} : { sessionId: input.fixedSessionId })
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1",
      kind: "agent.invoke",
      agentId: input.agentId,
      workspace: input.workspace,
      workspaceAccess: "write",
      networkAccess: true
    }
  };
}

export function scheduleDefinitionSnapshot(
  revision: ScheduleRevision
): Readonly<Record<string, unknown>> {
  if (revision.schemaVersion === "ScheduleRevision@3") {
    return {
      schema: "ScheduleDefinitionSnapshot@3",
      scheduleId: revision.scheduleId,
      revision: revision.revision,
      kind: revision.kind,
      expression: revision.expression,
      expressionVersion: revision.expressionVersion,
      ...(revision.timezone === undefined ? {} : { timezone: revision.timezone }),
      misfirePolicy: revision.misfirePolicy,
      overlapPolicy: revision.overlapPolicy,
      misfireGraceMilliseconds: revision.misfireGraceMilliseconds,
      target: revision.target,
      ...(revision.externalRefBinding === undefined
        ? {}
        : { externalRefBinding: revision.externalRefBinding }),
      createdAt: revision.createdAt
    };
  }
  if (revision.schemaVersion === "ScheduleRevision@2") {
    return {
      schema: "ScheduleDefinitionSnapshot@2",
      scheduleId: revision.scheduleId,
      revision: revision.revision,
      kind: revision.kind,
      expression: revision.expression,
      expressionVersion: revision.expressionVersion,
      ...(revision.timezone === undefined ? {} : { timezone: revision.timezone }),
      misfirePolicy: revision.misfirePolicy,
      overlapPolicy: revision.overlapPolicy,
      misfireGraceMilliseconds: revision.misfireGraceMilliseconds,
      sourceBinding: revision.sourceBinding,
      ...(revision.externalRefBinding === undefined
        ? {}
        : { externalRefBinding: revision.externalRefBinding }),
      createdAt: revision.createdAt
    };
  }
  return {
    schema: "ScheduleDefinitionSnapshot@1",
    scheduleId: revision.scheduleId,
    revision: revision.revision,
    agentId: revision.agentId,
    kind: revision.kind,
    expression: revision.expression,
    expressionVersion: revision.expressionVersion,
    ...(revision.timezone === undefined ? {} : { timezone: revision.timezone }),
    misfirePolicy: revision.misfirePolicy,
    overlapPolicy: revision.overlapPolicy,
    misfireGraceMilliseconds: revision.misfireGraceMilliseconds,
    sessionPolicy: revision.sessionPolicy,
    ...(revision.fixedSessionId === undefined
      ? {}
      : { fixedSessionId: revision.fixedSessionId }),
    prompt: revision.prompt,
    workspace: revision.workspace,
    callbacks: revision.callbacks,
    ...(revision.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: revision.externalRefBinding }),
    createdAt: revision.createdAt
  };
}

export function parseScheduleDefinitionSnapshot(value: string): ScheduleRevision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("ScheduledRun definition snapshot must be valid JSON");
  }
  if (!isRecord(parsed) || (parsed.schema !== "ScheduleDefinitionSnapshot@1" &&
    parsed.schema !== "ScheduleDefinitionSnapshot@2" &&
    parsed.schema !== "ScheduleDefinitionSnapshot@3")) {
    throw new Error("ScheduledRun definition snapshot schema is unsupported");
  }
  if (parsed.schema === "ScheduleDefinitionSnapshot@2") {
    return parseBoundScheduleDefinitionSnapshot(parsed);
  }
  if (parsed.schema === "ScheduleDefinitionSnapshot@3") {
    return parseTargetedScheduleDefinitionSnapshot(parsed);
  }
  if (typeof parsed.scheduleId !== "string" ||
    typeof parsed.revision !== "number" ||
    typeof parsed.agentId !== "string" ||
    (parsed.kind !== "once" && parsed.kind !== "cron") ||
    typeof parsed.expression !== "string" ||
    (parsed.expressionVersion !== "once-rfc3339-v1" &&
      parsed.expressionVersion !== "cron-v1") ||
    (parsed.misfirePolicy !== "skip" && parsed.misfirePolicy !== "run_once") ||
    (parsed.overlapPolicy !== "skip" && parsed.overlapPolicy !== "queue") ||
    typeof parsed.misfireGraceMilliseconds !== "number" ||
    (parsed.sessionPolicy !== "new_each_run" && parsed.sessionPolicy !== "fixed") ||
    typeof parsed.prompt !== "string" ||
    typeof parsed.workspace !== "string" ||
    typeof parsed.createdAt !== "string") {
    throw new Error("ScheduledRun definition snapshot is malformed");
  }
  return {
    schemaVersion: "ScheduleRevision@1",
    scheduleId: parsed.scheduleId,
    revision: parsed.revision,
    agentId: parsed.agentId,
    kind: parsed.kind,
    expression: parsed.expression,
    expressionVersion: parsed.expressionVersion,
    ...(typeof parsed.timezone === "string" ? { timezone: parsed.timezone } : {}),
    misfirePolicy: parsed.misfirePolicy,
    overlapPolicy: parsed.overlapPolicy,
    misfireGraceMilliseconds: parsed.misfireGraceMilliseconds,
    sessionPolicy: parsed.sessionPolicy,
    ...(typeof parsed.fixedSessionId === "string"
      ? { fixedSessionId: parsed.fixedSessionId }
      : {}),
    prompt: parsed.prompt,
    workspace: parsed.workspace,
    callbacks: Array.isArray(parsed.callbacks)
      ? parsed.callbacks as unknown as readonly ProactiveCallbackDefinition[]
      : [legacyAgentCallback({
          agentId: parsed.agentId,
          kind: parsed.kind,
          expression: parsed.expression,
          ...(typeof parsed.timezone === "string" ? { timezone: parsed.timezone } : {}),
          misfirePolicy: parsed.misfirePolicy,
          overlapPolicy: parsed.overlapPolicy,
          misfireGraceMilliseconds: parsed.misfireGraceMilliseconds,
          sessionPolicy: parsed.sessionPolicy,
          ...(typeof parsed.fixedSessionId === "string"
            ? { fixedSessionId: parsed.fixedSessionId }
            : {}),
          prompt: parsed.prompt,
          workspace: parsed.workspace
        })],
    ...(parsed.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: parseExternalRefTriggerBinding(parsed.externalRefBinding) }),
    createdAt: parsed.createdAt
  };
}

function parseTargetedScheduleDefinitionSnapshot(
  parsed: Readonly<Record<string, unknown>>
): TargetedScheduleRevision {
  const common = parseScheduleSnapshotCommon(parsed, "ScheduleDefinitionSnapshot@3");
  const source = {
    kind: "schedule" as const,
    id: common.scheduleId,
    definitionRevision: `ScheduleRevision@3:${common.revision}`
  };
  return {
    schemaVersion: "ScheduleRevision@3",
    ...common,
    target: parseProactiveTarget(parsed.target, source)
  };
}

function parseScheduleSnapshotCommon(
  parsed: Readonly<Record<string, unknown>>,
  schema: string
): Omit<TargetedScheduleRevision, "schemaVersion" | "target"> {
  const required = [
    "schema", "scheduleId", "revision", "kind", "expression", "expressionVersion",
    "misfirePolicy", "overlapPolicy", "misfireGraceMilliseconds", "target", "createdAt"
  ];
  const optional = ["timezone", "externalRefBinding"];
  const unknown = Object.keys(parsed).filter(
    (key) => !required.includes(key) && !optional.includes(key)
  );
  if (parsed.schema !== schema || unknown.length > 0 ||
    required.some((key) => parsed[key] === undefined) ||
    typeof parsed.scheduleId !== "string" || typeof parsed.revision !== "number" ||
    (parsed.kind !== "once" && parsed.kind !== "cron") ||
    typeof parsed.expression !== "string" ||
    (parsed.expressionVersion !== "once-rfc3339-v1" && parsed.expressionVersion !== "cron-v1") ||
    (parsed.misfirePolicy !== "skip" && parsed.misfirePolicy !== "run_once") ||
    (parsed.overlapPolicy !== "skip" && parsed.overlapPolicy !== "queue") ||
    typeof parsed.misfireGraceMilliseconds !== "number" ||
    typeof parsed.createdAt !== "string") {
    throw new Error(`${schema} is malformed`);
  }
  return {
    scheduleId: requireScheduleId(textValue(parsed.scheduleId, "snapshot.scheduleId", 256)),
    revision: requireScheduleRevision(parsed.revision, "snapshot.revision"),
    kind: parsed.kind,
    expression: textValue(parsed.expression, "snapshot.expression", 512),
    expressionVersion: parsed.expressionVersion,
    ...(typeof parsed.timezone === "string" ? { timezone: parsed.timezone } : {}),
    misfirePolicy: parsed.misfirePolicy,
    overlapPolicy: parsed.overlapPolicy,
    misfireGraceMilliseconds: bounded(
      parsed.misfireGraceMilliseconds, 0, 604_800_000,
      "snapshot.misfireGraceMilliseconds"
    ),
    ...(parsed.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: parseExternalRefTriggerBinding(parsed.externalRefBinding) }),
    createdAt: isoValue(parsed.createdAt, "snapshot.createdAt")
  };
}

function parseBoundScheduleDefinitionSnapshot(
  parsed: Readonly<Record<string, unknown>>
): BoundScheduleRevision {
  const required = [
    "schema", "scheduleId", "revision", "kind", "expression", "expressionVersion",
    "misfirePolicy", "overlapPolicy", "misfireGraceMilliseconds", "sourceBinding",
    "createdAt"
  ];
  const optional = ["timezone", "externalRefBinding"];
  const unknown = Object.keys(parsed).filter(
    (key) => !required.includes(key) && !optional.includes(key)
  );
  if (unknown.length > 0 || required.some((key) => parsed[key] === undefined) ||
    typeof parsed.scheduleId !== "string" || typeof parsed.revision !== "number" ||
    (parsed.kind !== "once" && parsed.kind !== "cron") ||
    typeof parsed.expression !== "string" ||
    (parsed.expressionVersion !== "once-rfc3339-v1" &&
      parsed.expressionVersion !== "cron-v1") ||
    (parsed.misfirePolicy !== "skip" && parsed.misfirePolicy !== "run_once") ||
    (parsed.overlapPolicy !== "skip" && parsed.overlapPolicy !== "queue") ||
    typeof parsed.misfireGraceMilliseconds !== "number" ||
    (parsed.timezone !== undefined && typeof parsed.timezone !== "string") ||
    typeof parsed.createdAt !== "string") {
    throw new Error("ScheduleDefinitionSnapshot@2 is malformed");
  }
  return {
    schemaVersion: "ScheduleRevision@2",
    scheduleId: textValue(parsed.scheduleId, "snapshot.scheduleId", 256),
    revision: requireScheduleRevision(
      Number(parsed.revision),
      "snapshot.revision"
    ),
    kind: parsed.kind,
    expression: textValue(parsed.expression, "snapshot.expression", 512),
    expressionVersion: parsed.expressionVersion,
    ...(typeof parsed.timezone === "string" ? { timezone: parsed.timezone } : {}),
    misfirePolicy: parsed.misfirePolicy,
    overlapPolicy: parsed.overlapPolicy,
    misfireGraceMilliseconds: bounded(
      Number(parsed.misfireGraceMilliseconds),
      0,
      604_800_000,
      "snapshot.misfireGraceMilliseconds"
    ),
    sourceBinding: requireScheduleSourceBinding(parsed.sourceBinding),
    ...(parsed.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: parseExternalRefTriggerBinding(parsed.externalRefBinding) }),
    createdAt: isoValue(parsed.createdAt, "snapshot.createdAt")
  };
}

export function initialOccurrence(
  revision: ScheduleRevision,
  after: string
): ScheduledOccurrence {
  if (revision.kind === "once") {
    return {
      scheduledFor: revision.expression,
      occurrenceKey: revision.expression,
      missingLocalTime: false
    };
  }
  return nextCronOccurrence(revision.expression, revision.timezone!, after);
}

export function targetChanged(current: ScheduleRevision, next: ScheduleRevision): boolean {
  if (current.schemaVersion !== "ScheduleRevision@1" ||
    next.schemaVersion !== "ScheduleRevision@1") {
    return current.schemaVersion !== next.schemaVersion;
  }
  return current.agentId !== next.agentId ||
    current.workspace !== next.workspace ||
    current.sessionPolicy !== next.sessionPolicy ||
    current.fixedSessionId !== next.fixedSessionId ||
    JSON.stringify(current.externalRefBinding) !== JSON.stringify(next.externalRefBinding) ||
    JSON.stringify(current.callbacks) !== JSON.stringify(next.callbacks);
}

export function mapDefinition(row: DefinitionRow): ScheduleDefinition {
  return {
    scheduleId: row.schedule_id,
    ownerPrincipalId: row.owner_principal_id,
    status: row.status,
    currentRevision: row.current_revision,
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    ...(row.next_occurrence_key === null
      ? {}
      : { nextOccurrenceKey: row.next_occurrence_key }),
    nextOccurrenceMissing: row.next_occurrence_missing === 1,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapRevision(row: RevisionRow): ScheduleRevision {
  const externalRefBinding = decodeExternalRefTriggerBinding(row.external_ref_binding_json);
  if (row.definition_schema === "ScheduleRevision@3") {
    if (row.target_json === null) throw new Error("ScheduleRevision@3 target is missing");
    return {
      schemaVersion: "ScheduleRevision@3",
      scheduleId: row.schedule_id,
      revision: row.revision,
      kind: row.kind,
      expression: row.expression,
      expressionVersion: row.expression_version,
      ...(row.timezone === null ? {} : { timezone: row.timezone }),
      misfirePolicy: row.misfire_policy,
      overlapPolicy: row.overlap_policy,
      misfireGraceMilliseconds: row.misfire_grace_ms,
      target: parseProactiveTarget(JSON.parse(row.target_json) as unknown, {
        kind: "schedule",
        id: row.schedule_id,
        definitionRevision: `ScheduleRevision@3:${row.revision}`
      }),
      ...(externalRefBinding === undefined ? {} : { externalRefBinding }),
      createdAt: row.created_at
    };
  }
  if (row.definition_schema === "ScheduleRevision@2") {
    if (row.source_binding_json === null) {
      throw new Error("ScheduleRevision@2 source binding is missing");
    }
    const sourceBinding = decodeScheduleSourceBinding(row.source_binding_json);
    return {
      schemaVersion: "ScheduleRevision@2",
      scheduleId: row.schedule_id,
      revision: row.revision,
      kind: row.kind,
      expression: row.expression,
      expressionVersion: row.expression_version,
      ...(row.timezone === null ? {} : { timezone: row.timezone }),
      misfirePolicy: row.misfire_policy,
      overlapPolicy: row.overlap_policy,
      misfireGraceMilliseconds: row.misfire_grace_ms,
      sourceBinding,
      ...(externalRefBinding === undefined ? {} : { externalRefBinding }),
      createdAt: row.created_at
    };
  }
  if (row.agent_id === null || row.session_policy === null || row.prompt === null ||
    row.workspace === null) {
    throw new Error("ScheduleRevision@1 target fields are missing");
  }
  return {
    schemaVersion: "ScheduleRevision@1",
    scheduleId: row.schedule_id,
    revision: row.revision,
    agentId: row.agent_id,
    kind: row.kind,
    expression: row.expression,
    expressionVersion: row.expression_version,
    ...(row.timezone === null ? {} : { timezone: row.timezone }),
    misfirePolicy: row.misfire_policy,
    overlapPolicy: row.overlap_policy,
    misfireGraceMilliseconds: row.misfire_grace_ms,
    sessionPolicy: row.session_policy,
    ...(row.fixed_session_id === null ? {} : { fixedSessionId: row.fixed_session_id }),
    prompt: row.prompt,
    workspace: row.workspace,
    callbacks: [],
    ...(externalRefBinding === undefined ? {} : { externalRefBinding }),
    createdAt: row.created_at
  };
}

export function mapRun(row: RunRow): ScheduledRun {
  const admissionReceipt = row.admission_receipt_json === null
    ? undefined
    : parseScheduleOccurrenceAdmissionReceipt(row.admission_receipt_json);
  return {
    runId: row.run_id,
    scheduleId: row.schedule_id,
    occurrenceKey: row.occurrence_key,
    scheduledFor: row.scheduled_for,
    scheduleRevision: row.schedule_revision,
    ...(row.coalesced_through === null ? {} : { coalescedThrough: row.coalesced_through }),
    ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }),
    status: row.status,
    ...(row.event_id === null ? {} : { eventId: row.event_id }),
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.agent_run_id === null ? {} : { agentRunId: row.agent_run_id }),
    ...(row.cycle_id === null ? {} : { cycleId: row.cycle_id }),
    ...(admissionReceipt === undefined ? {} : { admissionReceipt }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
  };
}

export function encodeScheduleSourceBinding(binding: RunSourceBinding): string {
  return JSON.stringify(requireScheduleSourceBinding(binding));
}

export function decodeScheduleSourceBinding(value: string): BoundScheduleRevision["sourceBinding"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Schedule source binding must be valid JSON");
  }
  return requireScheduleSourceBinding(parsed);
}

export function encodeProactiveTarget(target: ProactiveTarget): string {
  return JSON.stringify(parseProactiveTarget(target));
}

export function parseScheduleOccurrenceAdmissionReceipt(
  value: string | unknown
): ScheduleOccurrenceAdmissionReceipt {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Schedule occurrence admission receipt must be valid JSON");
    }
  }
  if (!isRecord(parsed)) {
    throw new Error("Schedule occurrence admission receipt must be an object");
  }
  const keys = [
    "schemaVersion", "scheduleId", "occurrenceId", "agentRunId", "cycleId",
    "orchestratorEventId", "orchestratorExecutionId", "admittedAt"
  ];
  const unknown = Object.keys(parsed).filter((key) => !keys.includes(key));
  if (unknown.length > 0 || parsed.schemaVersion !== "ScheduleOccurrenceAdmissionReceipt@1") {
    throw new Error("Schedule occurrence admission receipt is unsupported");
  }
  return {
    schemaVersion: "ScheduleOccurrenceAdmissionReceipt@1",
    scheduleId: requireScheduleId(textValue(parsed.scheduleId, "receipt.scheduleId", 256)),
    occurrenceId: requireScheduledRunId(
      textValue(parsed.occurrenceId, "receipt.occurrenceId", 256),
      "receipt.occurrenceId"
    ),
    agentRunId: requireAgentRunId(
      textValue(parsed.agentRunId, "receipt.agentRunId", 256)
    ),
    cycleId: requireAgentRunCycleId(
      textValue(parsed.cycleId, "receipt.cycleId", 256)
    ),
    orchestratorEventId: requireRuntimeId(
      textValue(parsed.orchestratorEventId, "receipt.orchestratorEventId", 256),
      "evt",
      "receipt.orchestratorEventId"
    ),
    orchestratorExecutionId: requireRuntimeId(
      textValue(parsed.orchestratorExecutionId, "receipt.orchestratorExecutionId", 256),
      "exe",
      "receipt.orchestratorExecutionId"
    ),
    admittedAt: isoValue(parsed.admittedAt, "receipt.admittedAt")
  };
}

export function validateRunStatus(value: string): asserts value is ScheduledRunStatus {
  if (!["queued", "running", "succeeded", "failed", "skipped", "unknown"].includes(value)) {
    throw new Error(`unsupported ScheduledRun status: ${value}`);
  }
}

export function terminalRunStatus(status: ScheduledRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

export function text(value: string, field: string, maximum: number): string {
  if (value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return value;
}

export function optionalText(
  value: string | undefined,
  field: string,
  maximum: number
): void {
  if (value !== undefined) text(value, field, maximum);
}

export function iso(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be a valid instant`);
  return new Date(milliseconds).toISOString();
}

export function bounded(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireScheduleSourceBinding(value: unknown): BoundScheduleRevision["sourceBinding"] {
  const binding = parseRunSourceBinding(value);
  if (binding.source.kind !== "schedule") {
    throw new Error("Schedule source binding kind must be schedule");
  }
  return binding as BoundScheduleRevision["sourceBinding"];
}

function textValue(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return text(value, field, maximum);
}

function isoValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return iso(value, field);
}

export function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
