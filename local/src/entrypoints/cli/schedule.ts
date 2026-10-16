import {
  controlSchedule,
  resolveUnknownScheduledRun,
  runScheduleNow,
} from "../../application/schedule/control.js";
import {
  inspectScheduleView,
  listScheduleOccurrenceViews,
  listScheduleViews,
  scheduleDetailView,
  scheduleOccurrenceView,
  traceScheduleOccurrenceView
} from "../../application/schedule/query.js";
import { migrateLegacyScheduleToExternalWorkflow } from
  "../../application/proactive/source-migration.js";
import { readScheduleRegistration, registerExternalWorkflowSchedule } from
  "../../application/proactive/schedule-registration.js";
import { registerCodexDesktopReminderSchedule } from "../../application/proactive/desktop-reminder-registration.js";

interface Output {
  readonly write: (text: string) => void;
}

const HELP = [
  "Usage:",
  "  scripts/rs schedule list",
  "  scripts/rs schedule register-workflow <registration.json>",
  "  scripts/rs schedule register-reminder <registration.json>",
  "  scripts/rs schedule inspect|pause|resume|cancel <schedule-id>",
  "  scripts/rs schedule run-now <schedule-id> --request-id <idempotency-key>",
  "  scripts/rs schedule migrate-workflow <schedule-id> --workflow-ref <ref> --expected-revision <n> --request-id <idempotency-key>",
  "  scripts/rs schedule occurrences <schedule-id> [--limit <count>]",
  "  scripts/rs schedule runs <schedule-id> [--limit <count>] (legacy alias)",
  "  scripts/rs schedule trace <run-id>",
  "  scripts/rs schedule resolve <run-id> <succeeded|failed>"
].join("\n");

export function runScheduleCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "--help") {
    if (rest.length > 0) throw new Error("schedule help accepts no additional arguments");
    output.write(`${HELP}\n`);
    return 0;
  }
  if (command === "create" || command === "update") {
    throw new Error(
      "legacy_trigger_write_closed: start RunIntent@1; Steward await_source owns Schedule registration"
    );
  }
  if (command === "register-workflow") {
    requireCount(rest, 1, "schedule register-workflow requires one registration JSON path");
    write(output, registerExternalWorkflowSchedule(repoRoot, readScheduleRegistration(rest[0]!), runtimeDirectory));
    return 0;
  }
  if (command === "register-reminder") {
    requireCount(rest, 1, "schedule register-reminder requires one registration JSON path");
    write(output, registerCodexDesktopReminderSchedule(repoRoot, readScheduleRegistration(rest[0]!), runtimeDirectory));
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
  if (command === "migrate-workflow") {
    if (rest.length !== 7 || rest[1] !== "--workflow-ref" ||
      rest[3] !== "--expected-revision" || rest[5] !== "--request-id") {
      throw new Error(
        "schedule migrate-workflow requires <id> --workflow-ref <ref> " +
        "--expected-revision <n> --request-id <idempotency-key>"
      );
    }
    write(output, migrateLegacyScheduleToExternalWorkflow(repoRoot, {
      scheduleId: rest[0]!,
      workflowRef: rest[2]!,
      expectedRevision: commandInteger(rest[4], "expectedRevision"),
      requestId: rest[6]!
    }, runtimeDirectory));
    return 0;
  }
  if (command === "occurrences" || command === "runs") {
    if (rest.length !== 1 && !(rest.length === 3 && rest[1] === "--limit")) {
      throw new Error(`schedule ${command} requires <id> [--limit <count>]`);
    }
    const limit = rest.length === 1 ? 100 : commandInteger(rest[2], "limit");
    write(output, listScheduleOccurrenceViews(
      repoRoot,
      rest[0]!,
      runtimeDirectory,
      limit
    ));
    return 0;
  }
  if (command === "trace") {
    requireCount(rest, 1, "schedule trace requires exactly one run id");
    write(output, traceScheduleOccurrenceView(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  if (command === "resolve") {
    if (rest.length !== 2 || (rest[1] !== "succeeded" && rest[1] !== "failed")) {
      throw new Error("schedule resolve requires <run-id> <succeeded|failed>");
    }
    write(output, scheduleOccurrenceView(resolveUnknownScheduledRun(
      repoRoot,
      rest[0]!,
      rest[1],
      runtimeDirectory
    )));
    return 0;
  }
  throw new Error(
    "schedule requires list, inspect, pause, resume, cancel, " +
    "run-now, register-workflow, migrate-workflow, occurrences, runs, trace or resolve"
  );
}

function write(output: Output, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireCount(arguments_: readonly string[], count: number, error: string): void {
  if (arguments_.length !== count) throw new Error(error);
}


function commandInteger(value: string | undefined, field: string): number {
  if (value === undefined || !/^[0-9]+$/u.test(value)) {
    throw new Error(`${field} must be an integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}
