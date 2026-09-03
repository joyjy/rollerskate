import { createHash } from "node:crypto";

import {
  boundedContractValue,
  contractRecord,
  contractText,
  exactContractKeys,
  stableContractJson
} from "../steward/contract-codec.js";
import {
  parseRunSourceBinding,
  type RunSourceBinding
} from "../steward/source-contract.js";

export type TriggerSourceRef = RunSourceBinding["source"];

export const PROACTIVE_TARGET_SCHEMA = "ProactiveTarget@1";
export const EXTERNAL_WORKFLOW_TARGET_SCHEMA = "ExternalWorkflowTarget@1";
export const EXTERNAL_WORKFLOW_RECEIPT_SCHEMA = "ExternalWorkflowExecutionReceipt@1";
export const DETERMINISTIC_ACTION_RECEIPT_SCHEMA =
  "DeterministicApplicationActionReceipt@1";

export interface StewardRunProactiveTarget {
  readonly schemaVersion: typeof PROACTIVE_TARGET_SCHEMA;
  readonly kind: "steward_run";
  readonly sourceBinding: RunSourceBinding;
}

export interface ApplicationActionProactiveTarget {
  readonly schemaVersion: typeof PROACTIVE_TARGET_SCHEMA;
  readonly kind: "application_action";
  readonly actionRef: string;
  readonly registrationDigest: string;
  readonly input: unknown;
}

export interface ExternalWorkflowTarget {
  readonly schemaVersion: typeof EXTERNAL_WORKFLOW_TARGET_SCHEMA;
  readonly workflowRef: string;
  readonly registrationDigest: string;
  readonly input: unknown;
  readonly executionPolicy: {
    readonly schemaVersion: "ExternalWorkflowExecutionPolicy@1";
    readonly maxAttempts: number;
    readonly retryBackoffMilliseconds: number;
  };
}

export interface ExternalWorkflowProactiveTarget {
  readonly schemaVersion: typeof PROACTIVE_TARGET_SCHEMA;
  readonly kind: "external_workflow";
  readonly workflow: ExternalWorkflowTarget;
}

export type ProactiveTarget =
  | StewardRunProactiveTarget
  | ApplicationActionProactiveTarget
  | ExternalWorkflowProactiveTarget;

export type ExternalWorkflowExecutionStatus =
  | "queued"
  | "claimed"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "unknown";

export interface ExternalWorkflowExecutionReceipt {
  readonly schemaVersion: typeof EXTERNAL_WORKFLOW_RECEIPT_SCHEMA;
  readonly executionId: string;
  readonly source: TriggerSourceRef;
  readonly occurrenceKey: string;
  readonly targetDigest: string;
  readonly workflowRef: string;
  readonly registrationDigest: string;
  readonly status: "succeeded" | "failed" | "unknown";
  readonly attemptCount: number;
  readonly resolution: "runtime" | "manual";
  readonly summary?: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly completedAt: string;
}

export interface ExternalWorkflowExecution {
  readonly executionId: string;
  readonly source: TriggerSourceRef;
  readonly occurrenceKey: string;
  readonly target: ExternalWorkflowProactiveTarget;
  readonly observation: unknown;
  readonly status: ExternalWorkflowExecutionStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: string;
  readonly effectStartedAt?: string;
  readonly receipt?: ExternalWorkflowExecutionReceipt;
  readonly unknownReceipt?: ExternalWorkflowExecutionReceipt;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly updatedAt: string;
}

export interface ExternalWorkflowExecutionRuntime {
  enqueueInTransaction(input: {
    readonly target: ExternalWorkflowProactiveTarget;
    readonly source: TriggerSourceRef;
    readonly occurrenceKey: string;
    readonly observation: unknown;
    readonly at: string;
  }): ExternalWorkflowExecution;
  execution(
    source: TriggerSourceRef,
    occurrenceKey: string
  ): ExternalWorkflowExecution | undefined;
}

export interface DeterministicApplicationActionReceipt {
  readonly schemaVersion: typeof DETERMINISTIC_ACTION_RECEIPT_SCHEMA;
  readonly receiptId: string;
  readonly source: TriggerSourceRef;
  readonly occurrenceKey: string;
  readonly targetDigest: string;
  readonly actionRef: string;
  readonly registrationDigest: string;
  readonly status: "succeeded" | "skipped" | "failed";
  readonly summary?: string;
  readonly output?: unknown;
  readonly error?: string;
  readonly completedAt: string;
}

export interface DeterministicApplicationActionRuntime {
  executeInTransaction(input: {
    readonly target: ApplicationActionProactiveTarget;
    readonly source: TriggerSourceRef;
    readonly occurrenceKey: string;
    readonly observation: unknown;
    readonly at: string;
  }): DeterministicApplicationActionReceipt;
  receipt(
    source: TriggerSourceRef,
    occurrenceKey: string
  ): DeterministicApplicationActionReceipt | undefined;
}

export function stewardRunProactiveTarget(
  sourceBinding: RunSourceBinding
): StewardRunProactiveTarget {
  return parseProactiveTarget({
    schemaVersion: PROACTIVE_TARGET_SCHEMA,
    kind: "steward_run",
    sourceBinding
  }) as StewardRunProactiveTarget;
}

export function proactiveTargetRunBinding(
  target: ProactiveTarget | unknown
): RunSourceBinding | undefined {
  const parsed = parseProactiveTarget(target);
  return parsed.kind === "steward_run" ? parsed.sourceBinding : undefined;
}

export function parseProactiveTarget(
  value: unknown,
  expectedSource?: TriggerSourceRef
): ProactiveTarget {
  const input = contractRecord(value, PROACTIVE_TARGET_SCHEMA);
  if (input.schemaVersion !== PROACTIVE_TARGET_SCHEMA) {
    throw new Error(`${PROACTIVE_TARGET_SCHEMA} schemaVersion is required`);
  }
  if (input.kind === "steward_run") {
    exactContractKeys(
      input,
      ["schemaVersion", "kind", "sourceBinding"],
      PROACTIVE_TARGET_SCHEMA
    );
    const sourceBinding = parseRunSourceBinding(input.sourceBinding);
    assertExpectedSource(sourceBinding.source, expectedSource);
    return {
      schemaVersion: PROACTIVE_TARGET_SCHEMA,
      kind: "steward_run",
      sourceBinding
    };
  }
  if (input.kind === "external_workflow") {
    exactContractKeys(
      input,
      ["schemaVersion", "kind", "workflow"],
      PROACTIVE_TARGET_SCHEMA
    );
    return {
      schemaVersion: PROACTIVE_TARGET_SCHEMA,
      kind: "external_workflow",
      workflow: parseExternalWorkflowTarget(input.workflow)
    };
  }
  exactContractKeys(
    input,
    ["schemaVersion", "kind", "actionRef", "registrationDigest", "input"],
    PROACTIVE_TARGET_SCHEMA
  );
  if (input.kind !== "application_action") {
    throw new Error(`${PROACTIVE_TARGET_SCHEMA} kind is unsupported`);
  }
  const target: ApplicationActionProactiveTarget = {
    schemaVersion: PROACTIVE_TARGET_SCHEMA,
    kind: "application_action",
    actionRef: actionRef(input.actionRef),
    registrationDigest: digest(input.registrationDigest, "registrationDigest"),
    input: boundedContractValue(input.input, "application action input")
  };
  return target;
}

export function parseExternalWorkflowTarget(value: unknown): ExternalWorkflowTarget {
  const input = contractRecord(value, EXTERNAL_WORKFLOW_TARGET_SCHEMA);
  exactContractKeys(
    input,
    ["schemaVersion", "workflowRef", "registrationDigest", "input", "executionPolicy"],
    EXTERNAL_WORKFLOW_TARGET_SCHEMA
  );
  if (input.schemaVersion !== EXTERNAL_WORKFLOW_TARGET_SCHEMA) {
    throw new Error(`${EXTERNAL_WORKFLOW_TARGET_SCHEMA} schemaVersion is required`);
  }
  const executionPolicy = contractRecord(
    input.executionPolicy,
    "ExternalWorkflowTarget@1.executionPolicy"
  );
  exactContractKeys(executionPolicy, [
    "schemaVersion", "maxAttempts", "retryBackoffMilliseconds"
  ], "ExternalWorkflowTarget@1.executionPolicy");
  if (executionPolicy.schemaVersion !== "ExternalWorkflowExecutionPolicy@1") {
    throw new Error("ExternalWorkflowExecutionPolicy@1 is required");
  }
  return {
    schemaVersion: EXTERNAL_WORKFLOW_TARGET_SCHEMA,
    workflowRef: workflowRef(input.workflowRef),
    registrationDigest: digest(input.registrationDigest, "registrationDigest"),
    input: boundedContractValue(input.input, "external workflow input"),
    executionPolicy: {
      schemaVersion: "ExternalWorkflowExecutionPolicy@1",
      maxAttempts: integer(executionPolicy.maxAttempts, "maxAttempts", 1, 5),
      retryBackoffMilliseconds: integer(
        executionPolicy.retryBackoffMilliseconds,
        "retryBackoffMilliseconds",
        1_000,
        3_600_000
      )
    }
  };
}

export function proactiveTargetDigest(target: ProactiveTarget | unknown): string {
  return sha256(stableContractJson(parseProactiveTarget(target)));
}

export function deterministicActionReceiptId(input: {
  readonly source: TriggerSourceRef;
  readonly occurrenceKey: string;
}): string {
  const digest = createHash("sha256").update(stableContractJson(input)).digest("base64url");
  return `dar1_${digest}`;
}

export function externalWorkflowExecutionId(input: {
  readonly source: TriggerSourceRef;
  readonly occurrenceKey: string;
}): string {
  const digest = createHash("sha256").update(stableContractJson(input)).digest("base64url");
  return `ewx1_${digest}`;
}

export function parseExternalWorkflowExecutionReceipt(
  value: unknown
): ExternalWorkflowExecutionReceipt {
  const input = contractRecord(value, EXTERNAL_WORKFLOW_RECEIPT_SCHEMA);
  exactContractKeys(input, [
    "schemaVersion", "executionId", "source", "occurrenceKey", "targetDigest",
    "workflowRef", "registrationDigest", "status", "attemptCount", "resolution",
    "summary", "exitCode", "stdout", "stderr", "error", "completedAt"
  ], EXTERNAL_WORKFLOW_RECEIPT_SCHEMA, [
    "summary", "exitCode", "stdout", "stderr", "error"
  ]);
  if (input.schemaVersion !== EXTERNAL_WORKFLOW_RECEIPT_SCHEMA ||
    (input.status !== "succeeded" && input.status !== "failed" && input.status !== "unknown") ||
    (input.resolution !== "runtime" && input.resolution !== "manual") ||
    !Number.isInteger(input.attemptCount) || (input.attemptCount as number) < 1) {
    throw new Error(`${EXTERNAL_WORKFLOW_RECEIPT_SCHEMA} is invalid`);
  }
  const source = triggerSource(input.source);
  if ((input.status === "succeeded") === (input.error !== undefined)) {
    throw new Error(
      "external workflow failure or unknown receipt must contain exactly one error"
    );
  }
  const occurrenceKey = contractText(input.occurrenceKey, "occurrenceKey", 512);
  const receipt: ExternalWorkflowExecutionReceipt = {
    schemaVersion: EXTERNAL_WORKFLOW_RECEIPT_SCHEMA,
    executionId: contractText(input.executionId, "executionId", 128),
    source,
    occurrenceKey,
    targetDigest: digest(input.targetDigest, "targetDigest"),
    workflowRef: workflowRef(input.workflowRef),
    registrationDigest: digest(input.registrationDigest, "registrationDigest"),
    status: input.status,
    attemptCount: input.attemptCount as number,
    resolution: input.resolution,
    ...(input.summary === undefined ? {} : {
      summary: contractText(input.summary, "summary", 4_096)
    }),
    ...(input.exitCode === undefined ? {} : {
      exitCode: integer(input.exitCode, "exitCode", 0, 255)
    }),
    ...(input.stdout === undefined ? {} : {
      stdout: boundedString(input.stdout, "stdout", 65_536)
    }),
    ...(input.stderr === undefined ? {} : {
      stderr: boundedString(input.stderr, "stderr", 65_536)
    }),
    ...(input.error === undefined ? {} : {
      error: contractText(input.error, "error", 4_096)
    }),
    completedAt: iso(input.completedAt, "completedAt")
  };
  if (receipt.executionId !== externalWorkflowExecutionId({ source, occurrenceKey })) {
    throw new Error("external workflow executionId does not match its occurrence");
  }
  return receipt;
}

export function parseDeterministicApplicationActionReceipt(
  value: unknown
): DeterministicApplicationActionReceipt {
  const input = contractRecord(value, DETERMINISTIC_ACTION_RECEIPT_SCHEMA);
  exactContractKeys(input, [
    "schemaVersion", "receiptId", "source", "occurrenceKey", "targetDigest",
    "actionRef", "registrationDigest", "status", "summary", "output", "error",
    "completedAt"
  ], DETERMINISTIC_ACTION_RECEIPT_SCHEMA, ["summary", "output", "error"]);
  if (input.schemaVersion !== DETERMINISTIC_ACTION_RECEIPT_SCHEMA ||
    (input.status !== "succeeded" && input.status !== "skipped" &&
      input.status !== "failed")) {
    throw new Error(`${DETERMINISTIC_ACTION_RECEIPT_SCHEMA} is invalid`);
  }
  const source = triggerSource(input.source);
  const status = input.status;
  if ((status === "failed") !== (input.error !== undefined)) {
    throw new Error("deterministic action failure receipt must contain only one error");
  }
  const receipt: DeterministicApplicationActionReceipt = {
    schemaVersion: DETERMINISTIC_ACTION_RECEIPT_SCHEMA,
    receiptId: contractText(input.receiptId, "receiptId", 128),
    source,
    occurrenceKey: contractText(input.occurrenceKey, "occurrenceKey", 512),
    targetDigest: digest(input.targetDigest, "targetDigest"),
    actionRef: actionRef(input.actionRef),
    registrationDigest: digest(input.registrationDigest, "registrationDigest"),
    status,
    ...(input.summary === undefined
      ? {}
      : { summary: contractText(input.summary, "summary", 4_096) }),
    ...(input.output === undefined
      ? {}
      : { output: boundedContractValue(input.output, "action receipt output") }),
    ...(input.error === undefined
      ? {}
      : { error: contractText(input.error, "error", 4_096) }),
    completedAt: iso(input.completedAt, "completedAt")
  };
  if (receipt.receiptId !== deterministicActionReceiptId({
    source,
    occurrenceKey: receipt.occurrenceKey
  })) {
    throw new Error("deterministic action receiptId does not match its occurrence");
  }
  return receipt;
}

function assertExpectedSource(
  source: TriggerSourceRef,
  expected: TriggerSourceRef | undefined
): void {
  if (expected !== undefined && (
    source.kind !== expected.kind || source.id !== expected.id ||
    source.definitionRevision !== expected.definitionRevision
  )) {
    throw new Error(`${PROACTIVE_TARGET_SCHEMA} source does not match its definition`);
  }
}

function triggerSource(value: unknown): TriggerSourceRef {
  const input = contractRecord(value, "receipt.source");
  exactContractKeys(input, ["kind", "id", "definitionRevision"], "receipt.source");
  if (input.kind !== "schedule" && input.kind !== "subscription" &&
    input.kind !== "continuous_subscription") {
    throw new Error("receipt.source.kind is unsupported");
  }
  return {
    kind: input.kind,
    id: contractText(input.id, "receipt.source.id", 256),
    definitionRevision: contractText(
      input.definitionRevision,
      "receipt.source.definitionRevision",
      256
    )
  };
}

function actionRef(value: unknown): string {
  const ref = contractText(value, "actionRef", 256);
  if (!/^action:[a-z0-9][a-z0-9._/-]*@[1-9][0-9]*$/u.test(ref)) {
    throw new Error("actionRef must be a stable versioned action:<name>@<version> ref");
  }
  return ref;
}

function workflowRef(value: unknown): string {
  const ref = contractText(value, "workflowRef", 256);
  if (!/^workflow:[a-z0-9][a-z0-9._/-]*@[1-9][0-9]*$/u.test(ref)) {
    throw new Error("workflowRef must be a stable versioned workflow:<name>@<version> ref");
  }
  return ref;
}

function digest(value: unknown, field: string): string {
  const result = contractText(value, field, 71);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) {
    throw new Error(`${field} must be sha256:<64 lowercase hex>`);
  }
  return result;
}

function iso(value: unknown, field: string): string {
  const input = contractText(value, field, 64);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be RFC 3339`);
  return new Date(milliseconds).toISOString();
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${field} must be a string up to ${maximum} characters`);
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
