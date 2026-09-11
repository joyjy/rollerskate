import { parseBoundedJsonObject } from "../agent/result-envelope.js";
import { assertSpecCompatibility, resolveSpecToken } from "../spec/registry.js";

const MAX_SUMMARY = 4_096;
const MAX_OBJECTIVE = 16_384;
const MAX_ARTIFACTS = 100;
const MAX_OUTPUTS = 20;
const MAX_INPUT_BYTES = 32_768;
const MAX_OUTPUT_BYTES = 32_768;

interface AgentTurnResultBase {
  readonly schemaVersion: "AgentTurnResult@1";
  readonly summary: string;
  readonly artifactRefs: readonly string[];
  readonly observedWorkspaceRevision?: string;
}

export interface CompleteAgentTurnResult extends AgentTurnResultBase {
  readonly action: "complete";
  readonly outcome: "succeeded" | "failed" | "needs_human";
  readonly outputs?: readonly AgentTurnOutput[];
}

export interface AgentTurnOutput {
  readonly id: string;
  readonly title: string;
  readonly contentType: "application/json" | "text/markdown" | "text/plain";
  readonly schemaVersion?: string;
  readonly value: unknown;
}

export type AgentTurnMandate =
  | {
      readonly kind: "objective";
      readonly objective: string;
    }
  | {
      readonly kind: "workflow";
      readonly workflowRef: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    };

export interface DelegateAgentTurnResult extends AgentTurnResultBase {
  readonly action: "delegate";
  readonly targetAgentId: string;
  readonly mandate: AgentTurnMandate;
}

export type AgentTurnResult =
  | CompleteAgentTurnResult
  | DelegateAgentTurnResult;

export function parseAgentTurnResult(input: string): AgentTurnResult {
  const parsed = parseBoundedJsonObject(
    input,
    "AgentTurnResult@1 output must be one JSON object"
  );
  assertSpecCompatibility(
    "spec:rollerskate/agent-turn-result@1",
    parsed.schemaVersion,
    { kind: "result-contract" }
  );
  if (parsed.schemaVersion !== "AgentTurnResult@1") {
    throw new Error("AgentTurnResult@1 schemaVersion is required");
  }
  const common = {
    schemaVersion: "AgentTurnResult@1" as const,
    summary: text(parsed.summary, "summary", MAX_SUMMARY),
    artifactRefs: stringList(parsed.artifactRefs, "artifactRefs", MAX_ARTIFACTS),
    ...(parsed.observedWorkspaceRevision === undefined
      ? {}
      : {
          observedWorkspaceRevision: text(
            parsed.observedWorkspaceRevision,
            "observedWorkspaceRevision",
            512
          )
        })
  };
  if (parsed.action === "complete") {
    exactKeys(parsed, [
      "schemaVersion",
      "action",
      "outcome",
      "summary",
      "artifactRefs",
      ...(parsed.outputs === undefined ? [] : ["outputs"]),
      ...(parsed.observedWorkspaceRevision === undefined
        ? []
        : ["observedWorkspaceRevision"])
    ]);
    if (parsed.outcome !== "succeeded" &&
      parsed.outcome !== "failed" &&
      parsed.outcome !== "needs_human") {
      throw new Error("AgentTurnResult@1 complete outcome is unsupported");
    }
    return {
      ...common,
      action: "complete",
      outcome: parsed.outcome,
      ...(parsed.outputs === undefined
        ? {}
        : { outputs: parseRunOutputs(parsed.outputs) })
    };
  }
  if (parsed.action !== "delegate") {
    throw new Error("AgentTurnResult@1 action must be complete or delegate");
  }
  exactKeys(parsed, [
    "schemaVersion",
    "action",
    "targetAgentId",
    "mandate",
    "summary",
    "artifactRefs",
    ...(parsed.observedWorkspaceRevision === undefined
      ? []
      : ["observedWorkspaceRevision"])
  ]);
  return {
    ...common,
    action: "delegate",
    targetAgentId: text(parsed.targetAgentId, "targetAgentId", 256),
    mandate: mandate(parsed.mandate)
  };
}

function boundedValue(value: unknown, field: string): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error(`${field} must be JSON up to ${MAX_OUTPUT_BYTES} bytes`);
  }
  return JSON.parse(encoded) as unknown;
}

export function parseRunOutputs(value: unknown): AgentTurnOutput[] {
  if (!Array.isArray(value) || value.length > MAX_OUTPUTS) {
    throw new Error(`outputs must be an array of at most ${MAX_OUTPUTS} items`);
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`outputs[${index}] must be an object`);
    exactKeys(item, [
      "id", "title", "contentType", "value",
      ...(item.schemaVersion === undefined ? [] : ["schemaVersion"])
    ]);
    const id = text(item.id, `outputs[${index}].id`, 128);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || ids.has(id)) {
      throw new Error(`outputs[${index}].id must be unique and URL-safe`);
    }
    ids.add(id);
    if (item.contentType !== "application/json" &&
      item.contentType !== "text/markdown" && item.contentType !== "text/plain") {
      throw new Error(`outputs[${index}].contentType is unsupported`);
    }
    if (item.contentType !== "application/json" && typeof item.value !== "string") {
      throw new Error(`outputs[${index}].value must be text for ${item.contentType}`);
    }
    return {
      id,
      title: text(item.title, `outputs[${index}].title`, 256),
      contentType: item.contentType,
      ...(item.schemaVersion === undefined
        ? {}
        : { schemaVersion: text(item.schemaVersion, `outputs[${index}].schemaVersion`, 128) }),
      value: boundedValue(item.value, `outputs[${index}].value`)
    };
  });
}

function mandate(value: unknown): AgentTurnMandate {
  if (!isRecord(value)) throw new Error("delegate mandate must be an object");
  if (value.kind === "objective") {
    exactKeys(value, ["kind", "objective"]);
    return {
      kind: "objective",
      objective: text(value.objective, "mandate.objective", MAX_OBJECTIVE)
    };
  }
  if (value.kind !== "workflow") {
    throw new Error("delegate mandate kind must be objective or workflow");
  }
  exactKeys(value, ["kind", "workflowRef", "inputs"]);
  if (!isRecord(value.inputs)) {
    throw new Error("mandate.inputs must be an object");
  }
  const encoded = JSON.stringify(value.inputs);
  if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
    throw new Error(`mandate.inputs must be at most ${MAX_INPUT_BYTES} bytes`);
  }
  resolveSpecToken(value.workflowRef, { kind: "workflow" });
  return {
    kind: "workflow",
    workflowRef: text(value.workflowRef, "mandate.workflowRef", 256),
    inputs: value.inputs
  };
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`AgentTurnResult@1 has unknown field: ${unknown[0]}`);
  }
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new Error(`AgentTurnResult@1 is missing field: ${missing[0]}`);
  }
}

function stringList(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum ||
    value.some((item) => typeof item !== "string" ||
      item.trim() === "" || item.length > 2_048)) {
    throw new Error(`${field} must be a bounded string array`);
  }
  return value as string[];
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string up to ${maximum} characters`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
