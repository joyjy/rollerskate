import { parseBoundedJsonObject } from "../agent/result-envelope.js";
import {
  parseAgentTurnResult,
  type AgentTurnResult
} from "./result-contract.js";

const MAX_RATIONALE_BYTES = 4_096;
const MAX_EVIDENCE_ITEMS = 10;
const MAX_EVIDENCE_BYTES = 2_048;

interface AgentTurnAdjudicationBase {
  readonly schemaVersion: "AgentTurnAdjudication@1";
  readonly rationale: string;
}

export interface AcceptAgentTurnAdjudication extends AgentTurnAdjudicationBase {
  readonly decision: "accept";
  readonly normalizedResult: AgentTurnResult;
}

export interface RetryAgentTurnAdjudication extends AgentTurnAdjudicationBase {
  readonly decision: "retry";
  readonly safeToRetryEvidence: readonly string[];
}

export interface NeedsHumanAgentTurnAdjudication extends AgentTurnAdjudicationBase {
  readonly decision: "needs_human";
}

export type AgentTurnAdjudication =
  | AcceptAgentTurnAdjudication
  | RetryAgentTurnAdjudication
  | NeedsHumanAgentTurnAdjudication;

export function parseAgentTurnAdjudication(input: string): AgentTurnAdjudication {
  const value = parseBoundedJsonObject(
    input,
    "AgentTurnAdjudication@1 output must be one JSON object"
  );
  if (value.schemaVersion !== "AgentTurnAdjudication@1") {
    throw new Error("AgentTurnAdjudication@1 schemaVersion is required");
  }
  const rationale = text(value.rationale, "rationale", MAX_RATIONALE_BYTES);
  if (value.decision === "accept") {
    exactKeys(value, ["schemaVersion", "decision", "rationale", "normalizedResult"]);
    if (!isRecord(value.normalizedResult)) {
      throw new Error("normalizedResult must be an AgentTurnResult@1 object");
    }
    return {
      schemaVersion: "AgentTurnAdjudication@1",
      decision: "accept",
      rationale,
      normalizedResult: parseAgentTurnResult(JSON.stringify(value.normalizedResult))
    };
  }
  if (value.decision === "retry") {
    exactKeys(value, ["schemaVersion", "decision", "rationale", "safeToRetryEvidence"]);
    if (!Array.isArray(value.safeToRetryEvidence) ||
      value.safeToRetryEvidence.length < 1 ||
      value.safeToRetryEvidence.length > MAX_EVIDENCE_ITEMS) {
      throw new Error(
        `safeToRetryEvidence must contain 1-${MAX_EVIDENCE_ITEMS} bounded items`
      );
    }
    return {
      schemaVersion: "AgentTurnAdjudication@1",
      decision: "retry",
      rationale,
      safeToRetryEvidence: value.safeToRetryEvidence.map((item, index) =>
        text(item, `safeToRetryEvidence[${index}]`, MAX_EVIDENCE_BYTES))
    };
  }
  if (value.decision === "needs_human") {
    exactKeys(value, ["schemaVersion", "decision", "rationale"]);
    return {
      schemaVersion: "AgentTurnAdjudication@1",
      decision: "needs_human",
      rationale
    };
  }
  throw new Error("AgentTurnAdjudication@1 decision is unsupported");
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Error(`AgentTurnAdjudication@1 has unknown field: ${unknown}`);
  }
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) {
    throw new Error(`AgentTurnAdjudication@1 is missing field: ${missing}`);
  }
}

function text(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.trim() === "" ||
    Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${field} must contain 1-${maximumBytes} bytes`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
