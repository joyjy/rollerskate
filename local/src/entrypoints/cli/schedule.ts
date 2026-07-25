import { readFileSync, realpathSync } from "node:fs";

import {
  controlSchedule,
  createSchedule,
  resolveUnknownScheduledRun,
  runScheduleNow,
  updateSchedule,
  type ScheduleControlInput,
  type UpdateScheduleControlInput
} from "../../application/schedule/control.js";
import {
  inspectScheduleView,
  listScheduledRunViews,
  listScheduleViews,
  scheduleDetailView,
  scheduledRunView,
  traceScheduledRunView
} from "../../application/schedule/query.js";

interface Output {
  readonly write: (text: string) => void;
}

export function runScheduleCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "create") {
    requireCount(rest, 1, "schedule create requires exactly one JSON file");
    write(output, scheduleDetailView(createSchedule(
      repoRoot,
      parseScheduleFile(rest[0]!, false),
      runtimeDirectory
    )));
    return 0;
  }
  if (command === "update") {
    requireCount(rest, 2, "schedule update requires an id and one JSON file");
    write(output, scheduleDetailView(updateSchedule(
      repoRoot,
      rest[0]!,
      parseScheduleFile(rest[1]!, true),
      runtimeDirectory
    )));
    return 0;
  }
  if (command === "list") {
    requireCount(rest, 0, "schedule list accepts no arguments");
    write(output, listScheduleViews(repoRoot, runtimeDirectory));
    return 0;
  }
  if (command === "inspect") {
    requireCount(rest, 1, "schedule inspect requires exactly one id");
    write(output, inspectScheduleView(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  if (command === "pause" || command === "resume" || command === "cancel") {
    requireCount(rest, 1, `schedule ${command} requires exactly one id`);
    write(output, scheduleDetailView(
      controlSchedule(repoRoot, rest[0]!, command, runtimeDirectory)
    ));
    return 0;
  }
  if (command === "run-now") {
    if (rest.length !== 3 || rest[1] !== "--request-id") {
      throw new Error("schedule run-now requires <id> --request-id <idempotency-key>");
    }
    write(output, runScheduleNow(repoRoot, rest[0]!, rest[2]!, runtimeDirectory));
    return 0;
  }
  if (command === "runs") {
    if (rest.length !== 1 && !(rest.length === 3 && rest[1] === "--limit")) {
      throw new Error("schedule runs requires <id> [--limit <count>]");
    }
    const limit = rest.length === 1 ? 100 : commandInteger(rest[2], "limit");
    write(output, listScheduledRunViews(
      repoRoot,
      rest[0]!,
      runtimeDirectory,
      limit
    ));
    return 0;
  }
  if (command === "trace") {
    requireCount(rest, 1, "schedule trace requires exactly one run id");
    write(output, traceScheduledRunView(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  if (command === "resolve") {
    if (rest.length !== 2 || (rest[1] !== "succeeded" && rest[1] !== "failed")) {
      throw new Error("schedule resolve requires <run-id> <succeeded|failed>");
    }
    write(output, scheduledRunView(resolveUnknownScheduledRun(
      repoRoot,
      rest[0]!,
      rest[1],
      runtimeDirectory
    )));
    return 0;
  }
  throw new Error(
    "schedule requires create, update, list, inspect, pause, resume, cancel, " +
    "run-now, runs, trace or resolve"
  );
}

function parseScheduleFile(pathInput: string, update: false): ScheduleControlInput;
function parseScheduleFile(pathInput: string, update: true): UpdateScheduleControlInput;
function parseScheduleFile(
  pathInput: string,
  update: boolean
): ScheduleControlInput | UpdateScheduleControlInput {
  const path = realpathSync(pathInput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`schedule file must be valid JSON: ${message(error)}`);
  }
  const root = record(parsed, "schedule file");
  exactKeys(root, [
    "schemaVersion",
    "agent",
    "kind",
    "expression",
    "timezone",
    "misfirePolicy",
    "overlapPolicy",
    "misfireGraceMilliseconds",
    "session",
    "prompt",
    ...(update ? ["expectedRevision"] : [])
  ], "schedule file");
  if (root.schemaVersion !== 1) throw new Error("schedule file schemaVersion must be 1");
  const kind = oneOf(root.kind, ["once", "cron"] as const, "kind");
  const timezone = optionalText(root.timezone, "timezone");
  if (kind === "cron" && timezone === undefined) {
    throw new Error("cron schedule requires timezone");
  }
  if (kind === "once" && timezone !== undefined) {
    throw new Error("once schedule must not define timezone");
  }
  const session = record(root.session, "session");
  exactKeys(session, ["policy", "fixedSessionId"], "session");
  const sessionPolicy = oneOf(
    session.policy,
    ["new_each_run", "fixed"] as const,
    "session.policy"
  );
  const fixedSessionId = optionalText(session.fixedSessionId, "session.fixedSessionId");
  if (sessionPolicy === "fixed" && fixedSessionId === undefined) {
    throw new Error("fixed session policy requires session.fixedSessionId");
  }
  if (sessionPolicy === "new_each_run" && fixedSessionId !== undefined) {
    throw new Error("new_each_run session policy must not define session.fixedSessionId");
  }
  const common: ScheduleControlInput = {
    agent: text(root.agent, "agent"),
    kind,
    expression: text(root.expression, "expression"),
    ...(timezone === undefined ? {} : { timezone }),
    misfirePolicy: oneOf(
      root.misfirePolicy,
      ["skip", "run_once"] as const,
      "misfirePolicy"
    ),
    overlapPolicy: oneOf(
      root.overlapPolicy,
      ["skip", "queue"] as const,
      "overlapPolicy"
    ),
    misfireGraceMilliseconds: integer(
      root.misfireGraceMilliseconds,
      "misfireGraceMilliseconds"
    ),
    sessionPolicy,
    ...(fixedSessionId === undefined ? {} : { fixedSessionId }),
    prompt: text(root.prompt, "prompt")
  };
  if (!update) return common;
  return {
    ...common,
    expectedRevision: integer(root.expectedRevision, "expectedRevision")
  };
}

function write(output: Output, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireCount(arguments_: readonly string[], count: number, error: string): void {
  if (arguments_.length !== count) throw new Error(error);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} has unknown field: ${unknown[0]}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field);
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return value as number;
}

function commandInteger(value: string | undefined, field: string): number {
  if (value === undefined || !/^[0-9]+$/u.test(value)) {
    throw new Error(`${field} must be an integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
