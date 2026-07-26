import { readFileSync, realpathSync } from "node:fs";

import {
  cancelAgentRun,
  startAgentRun,
  type StartAgentRunInput
} from "../../application/agent-run/control.js";
import {
  inspectAgentRunView,
  listAgentRunViews
} from "../../application/agent-run/query.js";

interface Output {
  readonly write: (text: string) => void;
}

export function runAgentRunCommand(
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
    write(output, startAgentRun(
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
    write(output, listAgentRunViews(
      repoRoot,
      runtimeDirectory,
      rest.length === 0 ? 100 : integer(rest[1], "limit", 1, 1_000)
    ));
    return 0;
  }
  if (command === "inspect" || command === "trace") {
    requireCount(rest, 1, `run ${command} requires exactly one Agent Run id`);
    write(output, inspectAgentRunView(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  if (command === "cancel") {
    requireCount(rest, 1, "run cancel requires exactly one Agent Run id");
    write(output, cancelAgentRun(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  throw new Error("run requires start, list, inspect, trace or cancel");
}

function parseRunFile(pathInput: string): Omit<StartAgentRunInput, "requestId"> {
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
    "steward",
    "objective",
    "workflowRef",
    "inputs",
    "workspace",
    "maxSteps",
    "maxDepth",
    "deadlineAt"
  ]);
  if (root.schemaVersion !== 1) throw new Error("run file schemaVersion must be 1");
  const workspace = root.workspace === undefined
    ? undefined
    : workspaceInput(root.workspace);
  return {
    steward: text(root.steward, "steward"),
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
      : { deadlineAt: text(root.deadlineAt, "deadlineAt") })
  };
}

function workspaceInput(value: unknown): {
  readonly root: string;
  readonly access: "read" | "write";
} {
  const workspace = record(value, "workspace");
  exactKeys(workspace, ["root", "access"]);
  if (workspace.access !== "read" && workspace.access !== "write") {
    throw new Error("workspace.access must be read or write");
  }
  return {
    root: text(workspace.root, "workspace.root"),
    access: workspace.access
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
