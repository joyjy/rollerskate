const MAX_SUMMARY = 4_096;
const MAX_OBJECTIVE = 16_384;
const MAX_ARTIFACTS = 100;
const MAX_INPUT_BYTES = 32_768;

interface AgentTurnResultBase {
  readonly schemaVersion: "AgentTurnResult@1";
  readonly summary: string;
  readonly artifactRefs: readonly string[];
  readonly observedWorkspaceRevision?: string;
}

export interface CompleteAgentTurnResult extends AgentTurnResultBase {
  readonly action: "complete";
  readonly outcome: "succeeded" | "failed" | "needs_human";
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new Error("AgentTurnResult@1 output must be one JSON object");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== "AgentTurnResult@1") {
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
      outcome: parsed.outcome
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
