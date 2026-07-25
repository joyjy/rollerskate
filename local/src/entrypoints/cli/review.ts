import { readFileSync, realpathSync } from "node:fs";

import {
  createReview,
  recoverReview,
  type CreateReviewControlInput
} from "../../application/review/control.js";
import {
  inspectReviewView,
  listReviewViews,
  reviewDetailView
} from "../../application/review/query.js";

interface Output {
  readonly write: (text: string) => void;
}

export function runReviewCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "create") {
    if (rest.length !== 3 || rest[1] !== "--request-id") {
      throw new Error("review create requires <json-file> --request-id <idempotency-key>");
    }
    const receipt = createReview(
      repoRoot,
      {
        ...parseReviewFile(rest[0]!),
        requestId: text(rest[2], "requestId")
      },
      runtimeDirectory
    );
    write(output, {
      ...receipt,
      review: reviewDetailView(receipt.review)
    });
    return 0;
  }
  if (command === "list") {
    if (rest.length !== 0 && !(rest.length === 2 && rest[0] === "--limit")) {
      throw new Error("review list accepts [--limit <count>]");
    }
    write(output, listReviewViews(
      repoRoot,
      runtimeDirectory,
      rest.length === 0 ? 100 : integer(rest[1], "limit")
    ));
    return 0;
  }
  if (command === "inspect" || command === "trace") {
    requireCount(rest, 1, `review ${command} requires exactly one root Event id`);
    write(output, inspectReviewView(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  if (command === "recover") {
    requireCount(rest, 1, "review recover requires exactly one root Event id");
    write(output, reviewDetailView(
      recoverReview(repoRoot, rest[0]!, runtimeDirectory)
    ));
    return 0;
  }
  throw new Error("review requires create, list, inspect, trace or recover");
}

function parseReviewFile(pathInput: string): Omit<CreateReviewControlInput, "requestId"> {
  const path = realpathSync(pathInput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`review file must be valid JSON: ${message(error)}`);
  }
  const root = record(parsed, "review file");
  exactKeys(
    root,
    ["schemaVersion", "subject", "reviewer", "implementer", "reworkLimit"],
    "review file"
  );
  if (root.schemaVersion !== 1) throw new Error("review file schemaVersion must be 1");
  return {
    subjectRef: realpathSync(text(root.subject, "subject")),
    reviewer: text(root.reviewer, "reviewer"),
    implementer: text(root.implementer, "implementer"),
    reworkLimit: integer(root.reworkLimit, "reworkLimit")
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

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return value as number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
