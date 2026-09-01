import type { ScheduledTaskStore } from
  "../../capabilities/scheduled-task/store.js";
import {
  newScheduleId,
  type BoundScheduleRevision,
  type CreateBoundScheduleInput
} from "../../capabilities/scheduled-task/model.js";
import { nextCronOccurrence } from "../../capabilities/scheduled-task/time.js";
import {
  runAuthorityDigest,
  type RunAuthorityEnvelope
} from "../../modules/steward/admission-contract.js";
import type { RunSourceBinding } from "../../modules/steward/source-contract.js";
import { resolveSpecToken } from "../../modules/spec/registry.js";
import type { StewardSourceBindingRegistrar } from "../steward/decision.js";
import type { ExternalRefTriggerBinding } from
  "../../modules/external-resource/trigger-binding.js";
import { parseExternalRefTriggerBinding } from
  "../../modules/external-resource/trigger-binding.js";
import type { ScheduleRunBindingAdapter } from
  "../../capabilities/scheduled-task/bound-runtime.js";
import type { RuntimeStore } from "../../core/runtime/store.js";
import type { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { activateRunSourceOccurrenceInTransaction } from
  "../steward/source-control.js";

export const SCHEDULE_ONCE_TEMPLATE_ID = "schedule.once@1";
export const SCHEDULE_CRON_TEMPLATE_ID = "schedule.cron@1";

export function scheduleRunBindingAdapter(input: {
  readonly runtime: RuntimeStore;
  readonly runs: AgentRunStore;
}): ScheduleRunBindingAdapter {
  return {
    activateOccurrenceInTransaction({ agentRunId, envelope, at }) {
      const receipt = activateRunSourceOccurrenceInTransaction({
        runtime: input.runtime,
        runs: input.runs,
        runId: agentRunId,
        envelope,
        at
      });
      return {
        cycleId: receipt.cycle.cycleId,
        orchestratorEventId: receipt.orchestratorEventId,
        orchestratorExecutionId: receipt.orchestratorExecutionId
      };
    },
    runState(runId) {
      const run = input.runs.projection(runId);
      return run === undefined
        ? undefined
        : {
            status: run.status,
            ...(run.activeCycleId === undefined ? {} : { activeCycleId: run.activeCycleId })
          };
    },
    cycleState(cycleId) {
      const cycle = input.runs.cycle(cycleId);
      return cycle === undefined
        ? undefined
        : {
            status: cycle.status,
            ...(cycle.terminalSummary === undefined
              ? {}
              : { terminalSummary: cycle.terminalSummary }),
            ...(cycle.completedAt === undefined ? {} : { completedAt: cycle.completedAt })
          };
    }
  };
}

export function scheduleSourceBindingRegistrar(
  schedules: ScheduledTaskStore
): StewardSourceBindingRegistrar {
  return ({ run, decision, at }) => {
    if (decision.awaitSource.sourceKind !== "schedule" ||
      run.orchestratorBinding?.schemaVersion !== "OrchestratorBinding@3") {
      throw new Error("Schedule source registration requires an admitted Schedule Run");
    }
    const input = parseScheduleTemplate(
      decision.awaitSource.templateId,
      decision.awaitSource.parameters
    );
    const authority = run.orchestratorBinding.authority.trigger;
    if (authority === undefined || !authority.allowedKinds.includes(input.kind)) {
      throw new Error(`Schedule kind is not admitted by Run authority: ${input.kind}`);
    }
    assertTimingAuthority(input, authority, at, run.deadlineAt);
    const existing = schedules.boundForRun(run.runId);
    const scheduleId = existing?.definition.scheduleId ?? newScheduleId();
    const seriesKey = `source:schedule:${run.runId}`;
    const sourceBinding: BoundScheduleRevision["sourceBinding"] = {
      schemaVersion: "RunSourceBinding@1",
      runId: run.runId,
      seriesKey,
      source: {
        kind: "schedule",
        id: scheduleId,
        definitionRevision: "ScheduleRevision@2:1"
      },
      authorityDigest: runAuthorityDigest(run.orchestratorBinding.authority),
      occurrencePolicy: input.kind === "once" ? "one_shot" : "recurring",
      cancellationPolicy: input.cancellationPolicy,
      reconcilePolicy: "source_owned"
    };
    const schedule = schedules.createBoundInTransaction({
      scheduleId,
      ownerPrincipalId: run.stewardAgentId,
      ...input,
      sourceBinding
    }, at);
    if (schedule.revision.schemaVersion !== "ScheduleRevision@2") {
      throw new Error("Schedule source registration returned a legacy definition");
    }
    resolveSpecToken(schedule.revision.schemaVersion, { kind: "contract" });
    return schedule.revision.sourceBinding;
  };
}

interface ScheduleTemplateInput extends Omit<
  CreateBoundScheduleInput,
  "scheduleId" | "ownerPrincipalId" | "sourceBinding"
> {
  readonly cancellationPolicy: RunSourceBinding["cancellationPolicy"];
}

function parseScheduleTemplate(
  templateId: string,
  parameters: Readonly<Record<string, unknown>>
): ScheduleTemplateInput {
  const template = resolveSpecToken(templateId, { kind: "template" });
  const capability = resolveSpecToken("scheduled-task@1", { kind: "capability" });
  if (template.capabilityRef !== capability.ref) {
    throw new Error("Schedule template is not owned by the Scheduled Task capability");
  }
  const kind = template.ref === "spec:rollerskate/schedule.once@1"
    ? "once"
    : template.ref === "spec:rollerskate/schedule.cron@1"
      ? "cron"
      : undefined;
  if (kind === undefined) throw new Error(`Unsupported Schedule template: ${templateId}`);
  exactKeys(parameters, [
    "expression",
    ...(kind === "cron" ? ["timezone"] : []),
    "misfirePolicy", "overlapPolicy", "misfireGraceMilliseconds",
    "cancellationPolicy", "externalRefBinding"
  ], ["externalRefBinding"]);
  const misfirePolicy = parameters.misfirePolicy;
  const overlapPolicy = parameters.overlapPolicy;
  const cancellationPolicy = parameters.cancellationPolicy;
  if (misfirePolicy !== "skip" && misfirePolicy !== "run_once") {
    throw new Error("Schedule template misfirePolicy is unsupported");
  }
  if (overlapPolicy !== "skip" && overlapPolicy !== "queue") {
    throw new Error("Schedule template overlapPolicy is unsupported");
  }
  if (cancellationPolicy !== "pause_source" && cancellationPolicy !== "cancel_source") {
    throw new Error("Schedule template cancellationPolicy is unsupported");
  }
  const grace = parameters.misfireGraceMilliseconds;
  if (!Number.isInteger(grace) || (grace as number) < 0 ||
    (grace as number) > 604_800_000) {
    throw new Error("Schedule template misfireGraceMilliseconds is out of range");
  }
  return {
    kind,
    expression: text(parameters.expression, "expression", 512),
    ...(kind === "cron"
      ? { timezone: text(parameters.timezone, "timezone", 128) }
      : {}),
    misfirePolicy,
    overlapPolicy,
    misfireGraceMilliseconds: grace as number,
    cancellationPolicy,
    ...(parameters.externalRefBinding === undefined
      ? {}
      : {
          externalRefBinding: parseExternalRefTriggerBinding(
            parameters.externalRefBinding
          ) as ExternalRefTriggerBinding
        })
  };
}

function assertTimingAuthority(
  input: ScheduleTemplateInput,
  authority: NonNullable<RunAuthorityEnvelope["trigger"]>,
  at: string,
  runDeadlineAt?: string
): void {
  const first = input.kind === "once"
    ? new Date(input.expression).toISOString()
    : nextCronOccurrence(input.expression, input.timezone!, at).scheduledFor;
  const interval = input.kind === "once"
    ? Date.parse(first) - Date.parse(at)
    : Date.parse(nextCronOccurrence(input.expression, input.timezone!, first).scheduledFor) -
      Date.parse(first);
  if (authority.minimumIntervalMilliseconds !== undefined &&
    interval < authority.minimumIntervalMilliseconds) {
    throw new Error("Schedule interval is below admitted trigger authority");
  }
  if (authority.maximumIntervalMilliseconds !== undefined &&
    interval > authority.maximumIntervalMilliseconds) {
    throw new Error("Schedule interval exceeds admitted trigger authority");
  }
  const deadline = authority.deadlineAt ?? runDeadlineAt;
  if (deadline !== undefined && Date.parse(first) > Date.parse(deadline)) {
    throw new Error("Schedule first occurrence exceeds admitted trigger deadline");
  }
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  optional: readonly string[]
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Schedule template has unknown field: ${unknown[0]}`);
  const missing = allowed.filter(
    (key) => !optional.includes(key) && value[key] === undefined
  );
  if (missing.length > 0) throw new Error(`Schedule template is missing field: ${missing[0]}`);
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}
