import { readFileSync, realpathSync } from "node:fs";

import {
  cancelStewardRun,
  closeStewardRunSeries,
  startStewardRun,
  submitCallerRunDecision,
  type StartStewardRunInput
} from "../../application/steward/control.js";
import {
  inspectStewardRunView,
  listStewardRunViews
} from "../../application/steward/query.js";

type WorkspaceEffect = Extract<
  NonNullable<StartStewardRunInput["workspace"]>,
  { readonly access: "write" }
>["effect"];

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
  if (command === "start") {
    if (rest.length !== 3 || rest[1] !== "--request-id") {
      throw new Error("run start requires <json-file> --request-id <idempotency-key>");
    }
    write(output, startStewardRun(
      repoRoot,
      {
        ...parseRunFile(rest[0]!),
        requestId: text(rest[2], "requestId")
      },
      runtimeDirectory
    ));
    return 0;
  }
  if (command === "list") {
    if (rest.length !== 0 && !(rest.length === 2 && rest[0] === "--limit")) {
      throw new Error("run list accepts [--limit <count>]");
    }
    write(output, listStewardRunViews(
      repoRoot,
      runtimeDirectory,
      rest.length === 0 ? 100 : integer(rest[1], "limit", 1, 1_000)
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
  throw new Error("run requires start, list, inspect, trace, decide, close or cancel");
}

function parseRunFile(pathInput: string): Omit<StartStewardRunInput, "requestId"> {
  const path = realpathSync(pathInput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`run file must be valid JSON: ${message(error)}`);
  }
  const root = record(parsed, "run file");
  exactKeys(root, [
    "schemaVersion",
    "series",
    "steward",
    "objective",
    "workflowRef",
    "inputs",
    "workspace",
    "maxSteps",
    "maxDepth",
    "deadlineAt",
    "taskUrl",
    "participantAgentIds",
    "orchestration"
  ]);
  if (root.schemaVersion !== 1) throw new Error("run file schemaVersion must be 1");
  const workspace = root.workspace === undefined
    ? undefined
    : workspaceInput(root.workspace);
  return {
    ...(root.series === undefined ? {} : { series: seriesInput(root.series) }),
    ...(root.steward === undefined ? {} : { steward: text(root.steward, "steward") }),
    ...(root.objective === undefined
      ? {}
      : { objective: text(root.objective, "objective") }),
    ...(root.workflowRef === undefined
      ? {}
      : { workflowRef: text(root.workflowRef, "workflowRef") }),
    ...(root.inputs === undefined
      ? {}
      : { inputs: record(root.inputs, "inputs") }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(root.maxSteps === undefined
      ? {}
      : { maxSteps: integer(root.maxSteps, "maxSteps", 1, 1_000) }),
    ...(root.maxDepth === undefined
      ? {}
      : { maxDepth: integer(root.maxDepth, "maxDepth", 0, 100) }),
    ...(root.deadlineAt === undefined
      ? {}
      : { deadlineAt: text(root.deadlineAt, "deadlineAt") }),
    ...(root.taskUrl === undefined
      ? {}
      : { taskUrl: text(root.taskUrl, "taskUrl") }),
    ...(root.participantAgentIds === undefined
      ? {}
      : { participantAgentIds: stringList(root.participantAgentIds, "participantAgentIds") }),
    ...(root.orchestration === undefined
      ? {}
      : { orchestration: orchestrationInput(root.orchestration) })
  };
}

function seriesInput(value: unknown): { readonly key: string; readonly sourceRevision: string } {
  const series = record(value, "series");
  exactKeys(series, ["key", "sourceRevision"]);
  return {
    key: text(series.key, "series.key"),
    sourceRevision: text(series.sourceRevision, "series.sourceRevision")
  };
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

function orchestrationInput(
  value: unknown
): { readonly mode: "autonomous" | "caller" | "steward" } {
  const orchestration = record(value, "orchestration");
  exactKeys(orchestration, ["mode"]);
  if (orchestration.mode !== "autonomous" && orchestration.mode !== "caller" &&
    orchestration.mode !== "steward") {
    throw new Error("orchestration.mode must be autonomous, caller or steward");
  }
  return { mode: orchestration.mode };
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error(`${field} must contain 1-64 strings`);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

function workspaceInput(value: unknown): {
  readonly root: string;
  readonly access: "read";
  readonly networkAccess?: boolean;
} | {
  readonly root: string;
  readonly access: "write";
  readonly effect: WorkspaceEffect;
  readonly networkAccess?: boolean;
} {
  const workspace = record(value, "workspace");
  exactKeys(workspace, ["root", "access", "effect", "networkAccess"]);
  if (workspace.access !== "read" && workspace.access !== "write") {
    throw new Error("workspace.access must be read or write");
  }
  if (workspace.networkAccess !== undefined &&
    typeof workspace.networkAccess !== "boolean") {
    throw new Error("workspace.networkAccess must be boolean");
  }
  if (workspace.networkAccess === true && workspace.access !== "write") {
    throw new Error("workspace.networkAccess requires workspace.access=write");
  }
  if (workspace.access === "write" && workspace.effect !== "must_change" &&
    workspace.effect !== "may_remain_unchanged") {
    throw new Error("workspace.effect is required for write access");
  }
  if (workspace.access === "read" && workspace.effect !== undefined) {
    throw new Error("workspace.effect is valid only with write access");
  }
  const root = text(workspace.root, "workspace.root");
  const networkAccess = workspace.networkAccess as boolean | undefined;
  if (workspace.access === "read") {
    return {
      root,
      access: "read",
      ...(networkAccess === undefined ? {} : { networkAccess })
    };
  }
  return {
    root,
    access: "write",
    effect: workspace.effect as WorkspaceEffect,
    ...(networkAccess === undefined ? {} : { networkAccess })
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
  allowed: readonly string[]
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`run file has unknown field: ${unknown[0]}`);
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
