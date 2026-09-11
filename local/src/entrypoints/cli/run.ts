import { compileRunIntentWithOwnerPolicy } from "../../application/steward/admission.js";
import { authorizeRunNetwork } from "../../application/steward/capability.js";
import { startStewardRunFromOwnerIntent } from "../../application/steward/intent-control.js";
import { stewardStatsView } from "../../application/steward/stats-query.js";
import { configureStewardPolicy, stewardPolicyView } from "../../application/steward/policy-control.js";
import { readFileSync, realpathSync } from "node:fs";

import {
  cancelStewardRun,
  closeStewardRunSeries,
  retryStewardOrchestrator,
  setStewardRunArchived,
  submitCallerRunDecision
} from "../../application/steward/control.js";
import {
  preflightStewardRunIntent,
  startStewardRunFromIntent
} from "../../application/steward/intent-control.js";
import {
  inspectStewardRunView,
  listStewardRunViews
} from "../../application/steward/query.js";
import { legacyExecutionInventory } from "../../application/steward/legacy-inventory.js";
import {
  applyLegacyTriggerMigration,
  legacyTriggerMigrationPlan
} from "../../application/steward/legacy-migration.js";

interface Output {
  readonly write: (text: string) => void;
}

export function runStewardCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "steward-policy") {
    if (rest.length > 1) throw new Error("run steward-policy accepts at most one policy JSON file");
    write(output, rest.length === 0 ? stewardPolicyView(repoRoot, runtimeDirectory)
      : configureStewardPolicy(repoRoot, parseJsonFile(rest[0]!, "StewardPolicy@1"), runtimeDirectory));
    return 0;
  }
  if (command === "steward-stats") {
    if (rest.length !== 0 && (rest.length !== 2 || rest[0] !== "--policy-digest")) {
      throw new Error("run steward-stats accepts [--policy-digest <sha256:digest>]");
    }
    write(output, stewardStatsView(repoRoot, runtimeDirectory, rest[1]));
    return 0;
  }
  if (command === "authorize-network") {
    if (rest.length !== 5 || rest[1] !== "--request-event" || rest[3] !== "--expected-version") throw new Error("run authorize-network requires <run-id> --request-event <event-id> --expected-version <version>");
    write(output, authorizeRunNetwork(repoRoot, rest[0]!, rest[2]!, integer(rest[4], "expectedVersion", 1, Number.MAX_SAFE_INTEGER), runtimeDirectory));
    return 0;
  }
  if (command === "preflight" && rest.length === 2 && rest[1] === "--authorize-network") {
    write(output, compileRunIntentWithOwnerPolicy(repoRoot, parseRunIntentFile(rest[0]!), {authorizeNetwork: true}, runtimeDirectory));
    return 0;
  }
  if (command === "start" && rest.length === 2 && rest[1] === "--authorize-network") {
    write(output, startStewardRunFromOwnerIntent(repoRoot, parseRunIntentFile(rest[0]!), {authorizeNetwork: true}, runtimeDirectory));
    return 0;
  }
  if (command === "start") {
    requireCount(rest, 1, "run start requires one RunIntent@1 JSON file");
    write(output, startStewardRunFromIntent(
      repoRoot,
      parseRunIntentFile(rest[0]!),
      runtimeDirectory
    ));
    return 0;
  }
  if (command === "preflight") {
    requireCount(rest, 1, "run preflight requires one RunIntent@1 JSON file");
    write(output, preflightStewardRunIntent(
      repoRoot,
      parseRunIntentFile(rest[0]!),
      runtimeDirectory
    ));
    return 0;
  }
  if (command === "list") {
    const archived = rest.includes("--archived");
    const limitOffset = rest.indexOf("--limit");
    const validLength = (archived ? 1 : 0) + (limitOffset === -1 ? 0 : 2);
    if (rest.length !== validLength ||
      (limitOffset !== -1 && rest[limitOffset + 1] === undefined)) {
      throw new Error("run list accepts [--limit <count>] [--archived]");
    }
    write(output, listStewardRunViews(
      repoRoot,
      runtimeDirectory,
      limitOffset === -1 ? 100 : integer(rest[limitOffset + 1], "limit", 1, 1_000),
      archived ? "archived" : "current"
    ));
    return 0;
  }
  if (command === "legacy-inventory") {
    requireCount(rest, 0, "run legacy-inventory accepts no arguments");
    write(output, legacyExecutionInventory(repoRoot, runtimeDirectory));
    return 0;
  }
  if (command === "legacy-migration-plan") {
    requireCount(rest, 0, "run legacy-migration-plan accepts no arguments");
    write(output, legacyTriggerMigrationPlan(repoRoot, runtimeDirectory));
    return 0;
  }
  if (command === "legacy-migrate") {
    requireCount(rest, 1, "run legacy-migrate requires one approval JSON file");
    write(output, applyLegacyTriggerMigration(
      repoRoot,
      parseJsonFile(rest[0]!, "LegacyTriggerMigrationApproval@1"),
      runtimeDirectory
    ));
    return 0;
  }
  if (command === "inspect" || command === "trace") {
    requireCount(rest, 1, `run ${command} requires exactly one Steward Run id`);
    write(output, inspectStewardRunView(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  if (command === "cancel") {
    requireCount(rest, 1, "run cancel requires exactly one Steward Run id");
    write(output, cancelStewardRun(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  if (command === "retry-orchestrator") {
    if (rest.length !== 3 || rest[1] !== "--request-id") {
      throw new Error(
        "run retry-orchestrator requires <run-id> --request-id <idempotency-key>"
      );
    }
    write(output, retryStewardOrchestrator(
      repoRoot,
      rest[0]!,
      text(rest[2], "requestId"),
      runtimeDirectory
    ));
    return 0;
  }
  if (command === "archive" || command === "unarchive") {
    requireCount(rest, 1, `run ${command} requires exactly one Steward Run id`);
    write(output, setStewardRunArchived(
      repoRoot,
      rest[0]!,
      command === "archive",
      runtimeDirectory
    ));
    return 0;
  }
  if (command === "close") {
    requireCount(rest, 1, "run close requires exactly one Steward Run id");
    write(output, closeStewardRunSeries(
      repoRoot,
      rest[0]!,
      "Source lifecycle closed",
      runtimeDirectory
    ));
    return 0;
  }
  if (command === "decide") {
    if (rest.length !== 4 || rest[2] !== "--request-id") {
      throw new Error(
        "run decide requires <run-id> <json-file> --request-id <idempotency-key>"
      );
    }
    write(output, submitCallerRunDecision(
      repoRoot,
      rest[0]!,
      {
        requestId: text(rest[3], "requestId"),
        decision: parseJsonFile(rest[1]!, "RunDecision@1")
      },
      runtimeDirectory
    ));
    return 0;
  }
  throw new Error(
    "run requires preflight, start, list, legacy-inventory, legacy-migration-plan, " +
    "legacy-migrate, inspect, trace, decide, retry-orchestrator, " +
    "authorize-network, close, cancel, archive or unarchive"
  );
}

function parseRunIntentFile(pathInput: string) {
  return parseJsonFile(pathInput, "RunIntent@1");
}

function parseJsonFile(
  pathInput: string,
  field: string
): Readonly<Record<string, unknown>> {
  const path = realpathSync(pathInput);
  try {
    return record(JSON.parse(readFileSync(path, "utf8")) as unknown, field);
  } catch (error) {
    throw new Error(`${field} file must be valid JSON: ${message(error)}`);
  }
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

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(number) ||
    (number as number) < minimum ||
    (number as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return number as number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
