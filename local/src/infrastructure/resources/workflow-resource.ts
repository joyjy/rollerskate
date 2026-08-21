import { readFileSync } from "node:fs";

import type {
  RunMandateSnapshot,
  WorkflowRunMandateSnapshot
} from "../../modules/steward/state-machine.js";

const MAX_OBJECTIVE = 16_384;
const MAX_INPUT_BYTES = 32_768;
const MAX_RENDERED_INSTRUCTION = 65_536;

export function inlineMandateSnapshot(objectiveInput: string): RunMandateSnapshot {
  const objective = text(objectiveInput, "objective", MAX_OBJECTIVE);
  return {
    schemaVersion: "RunMandateSnapshot@1",
    kind: "objective",
    objective,
    renderedInstruction: [
      "You are the Steward for one bounded Agent Run.",
      "Complete the objective yourself or delegate exactly one child Agent at a time.",
      "When a child completes, the Runtime will resume this Session with a typed callback.",
      "",
      "Objective:",
      objective
    ].join("\n")
  };
}

export function workflowMandateSnapshot(
  workflowRefInput: string,
  inputsInput: Readonly<Record<string, unknown>>
): WorkflowRunMandateSnapshot {
  const workflowRef = text(workflowRefInput, "workflowRef", 256);
  const match = /^([a-z][a-z0-9-]{0,63})@([1-9][0-9]{0,5})$/.exec(workflowRef);
  if (match === null) throw new Error("workflowRef must use <id>@<version>");
  const workflowId = match[1]!;
  const workflowVersion = Number(match[2]);
  const inputs = boundedInputs(inputsInput);
  const source = readFileSync(
    new URL(`../../../resources/workflows/${workflowId}.md`, import.meta.url),
    "utf8"
  );
  const { metadata, body } = frontmatter(source);
  if (metadata.type !== "Workflow" ||
    metadata.id !== workflowId ||
    Number(metadata.version) !== workflowVersion) {
    throw new Error(`Workflow resource does not match ${workflowRef}`);
  }
  const renderedInstruction = body.replaceAll(
    "{{INPUTS_JSON}}",
    JSON.stringify(inputs, null, 2)
  ).trim();
  if (/\{\{[A-Z0-9_]+\}\}/.test(renderedInstruction)) {
    throw new Error(`Workflow ${workflowRef} has unresolved placeholders`);
  }
  if (renderedInstruction.length > MAX_RENDERED_INSTRUCTION) {
    throw new Error(`Workflow ${workflowRef} exceeds rendered instruction budget`);
  }
  return {
    schemaVersion: "RunMandateSnapshot@1",
    kind: "workflow",
    workflowRef,
    workflowId,
    workflowVersion,
    inputs,
    renderedInstruction
  };
}

function boundedInputs(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workflow inputs must be an object");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
    throw new Error(`workflow inputs must be at most ${MAX_INPUT_BYTES} bytes`);
  }
  return JSON.parse(encoded) as Readonly<Record<string, unknown>>;
}

function frontmatter(source: string): {
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: string;
} {
  if (!source.startsWith("---\n")) throw new Error("Workflow frontmatter is missing");
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Workflow frontmatter is unterminated");
  const metadata: Record<string, string> = {};
  for (const line of source.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return {
    metadata,
    body: source.slice(end + 5)
  };
}

function text(value: string, field: string, maximum: number): string {
  if (value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be non-empty and at most ${maximum} characters`);
  }
  return value.trim();
}
