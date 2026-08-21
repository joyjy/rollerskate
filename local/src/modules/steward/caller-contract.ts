const MAX_SUMMARY = 4_096;
const MAX_TEXT = 16_384;
const MAX_LIST = 100;
const MAX_INPUT_BYTES = 32_768;

export interface ManualCallerOrchestratorBinding {
  readonly schemaVersion: "OrchestratorBinding@1";
  readonly mode: "caller";
  readonly callerRef: {
    readonly kind: "owner";
    readonly principalId: string;
  };
  readonly decisionContractId: "run-decision@1";
  readonly deliveryPolicy: "manual";
}

export interface RunResultDestination {
  readonly schemaVersion: "RunResultDestination@2";
  readonly destinationId: string;
  readonly delivery: {
    readonly kind: string;
    readonly address: Readonly<Record<string, string>>;
  };
}

export interface StewardOrchestratorBinding {
  readonly schemaVersion: "OrchestratorBinding@2";
  readonly mode: "caller";
  readonly callerRef: {
    readonly kind: "owner";
    readonly principalId: string;
  };
  readonly orchestratorRef: {
    readonly kind: "agent";
    readonly agentId: string;
  };
  readonly decisionContractId: "run-decision@2";
  readonly deliveryPolicy: "internal-with-manual-fallback";
  readonly resultDestination?: RunResultDestination;
}

export type CallerOrchestratorBinding =
  | ManualCallerOrchestratorBinding
  | StewardOrchestratorBinding;

export interface AgentStepResult {
  readonly schemaVersion: "AgentStepResult@1";
  readonly outcome: "succeeded" | "failed" | "needs_human";
  readonly summary: string;
  readonly artifactRefs: readonly string[];
  readonly acceptanceEvidence?: readonly string[];
  readonly unresolvedQuestions?: readonly string[];
  readonly observedWorkspaceRevision?: string;
}

export interface AgentRunCheckpoint {
  readonly schemaVersion: "AgentRunCheckpoint@1";
  readonly stepId: string;
  readonly agentId: string;
  readonly requestEventId: string;
  readonly resultEventId: string;
  readonly executionId: string;
  readonly result: AgentStepResult;
  readonly observedWorkspaceRevision?: string;
  readonly recordedAt: string;
}

export type RunDecisionTarget =
  | { readonly kind: "self" }
  | { readonly kind: "agent"; readonly agentId: string };

export type RunDecisionMandate =
  | { readonly kind: "objective"; readonly objective: string }
  | {
      readonly kind: "workflow";
      readonly workflowRef: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    };

interface RunDecisionBase {
  readonly schemaVersion: "RunDecision@1";
  readonly expectedRunVersion: number;
  readonly rationale: string;
  readonly checkedAcceptance: readonly string[];
}

export interface NextStepRunDecision extends RunDecisionBase {
  readonly action: "next_step";
  readonly nextStep: {
    readonly target: RunDecisionTarget;
    readonly mandate: RunDecisionMandate;
  };
}

export interface FinishRunDecision extends RunDecisionBase {
  readonly action: "finish";
  readonly finish: {
    readonly outcome: "succeeded" | "failed";
    readonly summary: string;
  };
}

export interface NeedsHumanRunDecision extends RunDecisionBase {
  readonly action: "needs_human";
}

export type RunDecision =
  | NextStepRunDecision
  | FinishRunDecision
  | NeedsHumanRunDecision;

export interface OrchestratorTask {
  readonly taskId: string;
  readonly objective: string;
  readonly status: "pending" | "active" | "completed" | "blocked";
  readonly assignedAgentId?: string;
  readonly summary?: string;
}

export interface OrchestratorState {
  readonly schemaVersion: "OrchestratorState@1";
  readonly goal: string;
  readonly tasks: readonly OrchestratorTask[];
  readonly acceptedEvidence: readonly string[];
  readonly unresolvedQuestions: readonly string[];
}

interface StewardRunDecisionBase {
  readonly schemaVersion: "RunDecision@2";
  readonly expectedRunVersion: number;
  readonly rationale: string;
  readonly checkedAcceptance: readonly string[];
  readonly state: OrchestratorState;
}

export interface StewardNextStepRunDecision extends StewardRunDecisionBase {
  readonly action: "next_step";
  readonly nextStep: {
    readonly target: RunDecisionTarget;
    readonly mandate: RunDecisionMandate;
  };
}

export interface StewardFinishRunDecision extends StewardRunDecisionBase {
  readonly action: "finish";
  readonly finish: {
    readonly outcome: "succeeded" | "failed";
    readonly summary: string;
  };
}

export interface StewardNeedsHumanRunDecision extends StewardRunDecisionBase {
  readonly action: "needs_human";
}

export type StewardRunDecision =
  | StewardNextStepRunDecision
  | StewardFinishRunDecision
  | StewardNeedsHumanRunDecision;

export type AnyRunDecision = RunDecision | StewardRunDecision;

export interface AgentRunDecisionReceipt {
  readonly schemaVersion: "AgentRunDecisionReceipt@1";
  readonly runId: string;
  readonly requestId: string;
  readonly expectedRunVersion: number;
  readonly resultingRunVersion: number;
  readonly sourceStepId: string;
  readonly action: AnyRunDecision["action"];
  readonly targetAgentId?: string;
  readonly nextStepId?: string;
  readonly nextEventId?: string;
  readonly nextExecutionId?: string;
  readonly terminalStatus?: "succeeded" | "failed" | "needs_human";
  readonly acceptedAt: string;
}

export function parseAgentStepResult(input: string): AgentStepResult {
  const parsed = jsonRecord(input, "AgentStepResult@1 output");
  exactKeys(parsed, [
    "schemaVersion", "outcome", "summary", "artifactRefs",
    "acceptanceEvidence", "unresolvedQuestions", "observedWorkspaceRevision"
  ], "AgentStepResult@1", [
    "acceptanceEvidence", "unresolvedQuestions", "observedWorkspaceRevision"
  ]);
  if (parsed.schemaVersion !== "AgentStepResult@1") {
    throw new Error("AgentStepResult@1 schemaVersion is required");
  }
  if (parsed.outcome !== "succeeded" && parsed.outcome !== "failed" &&
    parsed.outcome !== "needs_human") {
    throw new Error("AgentStepResult@1 outcome is unsupported");
  }
  return {
    schemaVersion: "AgentStepResult@1",
    outcome: parsed.outcome,
    summary: text(parsed.summary, "summary", MAX_SUMMARY),
    artifactRefs: stringList(parsed.artifactRefs, "artifactRefs"),
    ...(parsed.acceptanceEvidence === undefined
      ? {}
      : { acceptanceEvidence: stringList(parsed.acceptanceEvidence, "acceptanceEvidence") }),
    ...(parsed.unresolvedQuestions === undefined
      ? {}
      : { unresolvedQuestions: stringList(parsed.unresolvedQuestions, "unresolvedQuestions") }),
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
}

export function parseRunDecision(input: unknown): AnyRunDecision {
  const parsed = record(input, "RunDecision");
  if (parsed.schemaVersion === "RunDecision@2") {
    return parseStewardRunDecision(parsed);
  }
  return parseManualRunDecision(parsed);
}

function parseManualRunDecision(
  parsed: Readonly<Record<string, unknown>>
): RunDecision {
  const common = {
    schemaVersion: "RunDecision@1" as const,
    expectedRunVersion: integer(
      parsed.expectedRunVersion,
      "expectedRunVersion",
      1,
      Number.MAX_SAFE_INTEGER
    ),
    rationale: text(parsed.rationale, "rationale", MAX_SUMMARY),
    checkedAcceptance: stringList(parsed.checkedAcceptance, "checkedAcceptance")
  };
  if (parsed.schemaVersion !== "RunDecision@1") {
    throw new Error("RunDecision@1 schemaVersion is required");
  }
  if (parsed.action === "next_step") {
    exactKeys(parsed, [
      "schemaVersion", "action", "expectedRunVersion", "rationale",
      "checkedAcceptance", "nextStep"
    ], "RunDecision@1");
    const nextStep = record(parsed.nextStep, "nextStep");
    exactKeys(nextStep, ["target", "mandate"], "nextStep");
    return {
      ...common,
      action: "next_step",
      nextStep: {
        target: decisionTarget(nextStep.target),
        mandate: decisionMandate(nextStep.mandate)
      }
    };
  }
  if (parsed.action === "finish") {
    exactKeys(parsed, [
      "schemaVersion", "action", "expectedRunVersion", "rationale",
      "checkedAcceptance", "finish"
    ], "RunDecision@1");
    const finish = record(parsed.finish, "finish");
    exactKeys(finish, ["outcome", "summary"], "finish");
    if (finish.outcome !== "succeeded" && finish.outcome !== "failed") {
      throw new Error("finish.outcome must be succeeded or failed");
    }
    return {
      ...common,
      action: "finish",
      finish: {
        outcome: finish.outcome,
        summary: text(finish.summary, "finish.summary", MAX_SUMMARY)
      }
    };
  }
  if (parsed.action !== "needs_human") {
    throw new Error("RunDecision@1 action is unsupported");
  }
  exactKeys(parsed, [
    "schemaVersion", "action", "expectedRunVersion", "rationale",
    "checkedAcceptance"
  ], "RunDecision@1");
  return { ...common, action: "needs_human" };
}

function parseStewardRunDecision(
  parsed: Readonly<Record<string, unknown>>
): StewardRunDecision {
  const common = {
    schemaVersion: "RunDecision@2" as const,
    expectedRunVersion: integer(
      parsed.expectedRunVersion,
      "expectedRunVersion",
      1,
      Number.MAX_SAFE_INTEGER
    ),
    rationale: text(parsed.rationale, "rationale", MAX_SUMMARY),
    checkedAcceptance: stringList(parsed.checkedAcceptance, "checkedAcceptance"),
    state: orchestratorState(parsed.state)
  };
  if (parsed.action === "next_step") {
    exactKeys(parsed, [
      "schemaVersion", "action", "expectedRunVersion", "rationale",
      "checkedAcceptance", "state", "nextStep"
    ], "RunDecision@2");
    const nextStep = record(parsed.nextStep, "nextStep");
    exactKeys(nextStep, ["target", "mandate"], "nextStep");
    return {
      ...common,
      action: "next_step",
      nextStep: {
        target: decisionTarget(nextStep.target),
        mandate: decisionMandate(nextStep.mandate)
      }
    };
  }
  if (parsed.action === "finish") {
    exactKeys(parsed, [
      "schemaVersion", "action", "expectedRunVersion", "rationale",
      "checkedAcceptance", "state", "finish"
    ], "RunDecision@2");
    const finish = record(parsed.finish, "finish");
    exactKeys(finish, ["outcome", "summary"], "finish");
    if (finish.outcome !== "succeeded" && finish.outcome !== "failed") {
      throw new Error("finish.outcome must be succeeded or failed");
    }
    return {
      ...common,
      action: "finish",
      finish: {
        outcome: finish.outcome,
        summary: text(finish.summary, "finish.summary", MAX_SUMMARY)
      }
    };
  }
  if (parsed.action !== "needs_human") {
    throw new Error("RunDecision@2 action is unsupported");
  }
  exactKeys(parsed, [
    "schemaVersion", "action", "expectedRunVersion", "rationale",
    "checkedAcceptance", "state"
  ], "RunDecision@2");
  return { ...common, action: "needs_human" };
}

export function parseCallerOrchestratorBinding(
  input: string
): CallerOrchestratorBinding {
  const parsed = jsonRecord(input, "OrchestratorBinding");
  if (parsed.schemaVersion === "OrchestratorBinding@2") {
    return parseStewardOrchestratorBinding(parsed);
  }
  exactKeys(parsed, [
    "schemaVersion", "mode", "callerRef", "decisionContractId", "deliveryPolicy"
  ], "OrchestratorBinding@1");
  const callerRef = record(parsed.callerRef, "callerRef");
  exactKeys(callerRef, ["kind", "principalId"], "callerRef");
  if (parsed.schemaVersion !== "OrchestratorBinding@1" || parsed.mode !== "caller" ||
    callerRef.kind !== "owner" || parsed.decisionContractId !== "run-decision@1" ||
    parsed.deliveryPolicy !== "manual") {
    throw new Error("OrchestratorBinding@1 is unsupported");
  }
  return {
    schemaVersion: "OrchestratorBinding@1",
    mode: "caller",
    callerRef: {
      kind: "owner",
      principalId: text(callerRef.principalId, "callerRef.principalId", 256)
    },
    decisionContractId: "run-decision@1",
    deliveryPolicy: "manual"
  };
}

function parseStewardOrchestratorBinding(
  parsed: Readonly<Record<string, unknown>>
): StewardOrchestratorBinding {
  exactKeys(parsed, [
    "schemaVersion", "mode", "callerRef", "orchestratorRef",
    "decisionContractId", "deliveryPolicy", "resultDestination"
  ], "OrchestratorBinding@2", ["resultDestination"]);
  const callerRef = record(parsed.callerRef, "callerRef");
  exactKeys(callerRef, ["kind", "principalId"], "callerRef");
  const orchestratorRef = record(parsed.orchestratorRef, "orchestratorRef");
  exactKeys(orchestratorRef, ["kind", "agentId"], "orchestratorRef");
  if (parsed.mode !== "caller" || callerRef.kind !== "owner" ||
    orchestratorRef.kind !== "agent" ||
    parsed.decisionContractId !== "run-decision@2" ||
    parsed.deliveryPolicy !== "internal-with-manual-fallback") {
    throw new Error("OrchestratorBinding@2 is unsupported");
  }
  return {
    schemaVersion: "OrchestratorBinding@2",
    mode: "caller",
    callerRef: {
      kind: "owner",
      principalId: text(callerRef.principalId, "callerRef.principalId", 256)
    },
    orchestratorRef: {
      kind: "agent",
      agentId: text(orchestratorRef.agentId, "orchestratorRef.agentId", 256)
    },
    decisionContractId: "run-decision@2",
    deliveryPolicy: "internal-with-manual-fallback",
    ...(parsed.resultDestination === undefined
      ? {}
      : { resultDestination: runResultDestination(parsed.resultDestination) })
  };
}

export function isStewardOrchestrated(
  binding: CallerOrchestratorBinding | undefined
): binding is StewardOrchestratorBinding {
  return binding?.schemaVersion === "OrchestratorBinding@2";
}

export function latestOrchestratorState(
  decisions: readonly { readonly decision: AnyRunDecision }[]
): OrchestratorState | undefined {
  for (const record of decisions) {
    if (record.decision.schemaVersion === "RunDecision@2") return record.decision.state;
  }
  return undefined;
}

export function parseAgentRunCheckpoint(input: string): AgentRunCheckpoint {
  const parsed = jsonRecord(input, "AgentRunCheckpoint@1");
  exactKeys(parsed, [
    "schemaVersion", "stepId", "agentId", "requestEventId", "resultEventId",
    "executionId", "result", "observedWorkspaceRevision", "recordedAt"
  ], "AgentRunCheckpoint@1", ["observedWorkspaceRevision"]);
  if (parsed.schemaVersion !== "AgentRunCheckpoint@1") {
    throw new Error("AgentRunCheckpoint@1 schemaVersion is unsupported");
  }
  return {
    schemaVersion: "AgentRunCheckpoint@1",
    stepId: text(parsed.stepId, "checkpoint.stepId", 256),
    agentId: text(parsed.agentId, "checkpoint.agentId", 256),
    requestEventId: text(parsed.requestEventId, "checkpoint.requestEventId", 256),
    resultEventId: text(parsed.resultEventId, "checkpoint.resultEventId", 256),
    executionId: text(parsed.executionId, "checkpoint.executionId", 256),
    result: parseAgentStepResult(JSON.stringify(parsed.result)),
    ...(parsed.observedWorkspaceRevision === undefined
      ? {}
      : {
          observedWorkspaceRevision: text(
            parsed.observedWorkspaceRevision,
            "checkpoint.observedWorkspaceRevision",
            512
          )
        }),
    recordedAt: iso(parsed.recordedAt, "checkpoint.recordedAt")
  };
}

export function parseAgentRunDecisionReceipt(
  input: string
): AgentRunDecisionReceipt {
  const parsed = jsonRecord(input, "AgentRunDecisionReceipt@1");
  exactKeys(parsed, [
    "schemaVersion", "runId", "requestId", "expectedRunVersion",
    "resultingRunVersion", "sourceStepId", "action", "targetAgentId",
    "nextStepId", "nextEventId", "nextExecutionId", "terminalStatus", "acceptedAt"
  ], "AgentRunDecisionReceipt@1", [
    "targetAgentId", "nextStepId", "nextEventId", "nextExecutionId", "terminalStatus"
  ]);
  if (parsed.schemaVersion !== "AgentRunDecisionReceipt@1" ||
    (parsed.action !== "next_step" && parsed.action !== "finish" &&
      parsed.action !== "needs_human")) {
    throw new Error("AgentRunDecisionReceipt@1 is unsupported");
  }
  const terminalStatus = parsed.terminalStatus;
  if (terminalStatus !== undefined && terminalStatus !== "succeeded" &&
    terminalStatus !== "failed" && terminalStatus !== "needs_human") {
    throw new Error("AgentRunDecisionReceipt@1 terminalStatus is unsupported");
  }
  return {
    schemaVersion: "AgentRunDecisionReceipt@1",
    runId: text(parsed.runId, "receipt.runId", 256),
    requestId: text(parsed.requestId, "receipt.requestId", 256),
    expectedRunVersion: integer(parsed.expectedRunVersion, "expectedRunVersion", 1, Number.MAX_SAFE_INTEGER),
    resultingRunVersion: integer(parsed.resultingRunVersion, "resultingRunVersion", 2, Number.MAX_SAFE_INTEGER),
    sourceStepId: text(parsed.sourceStepId, "receipt.sourceStepId", 256),
    action: parsed.action,
    ...optionalText(parsed, "targetAgentId"),
    ...optionalText(parsed, "nextStepId"),
    ...optionalText(parsed, "nextEventId"),
    ...optionalText(parsed, "nextExecutionId"),
    ...(terminalStatus === undefined ? {} : { terminalStatus }),
    acceptedAt: iso(parsed.acceptedAt, "receipt.acceptedAt")
  };
}

function decisionTarget(value: unknown): RunDecisionTarget {
  const target = record(value, "nextStep.target");
  if (target.kind === "self") {
    exactKeys(target, ["kind"], "nextStep.target");
    return { kind: "self" };
  }
  exactKeys(target, ["kind", "agentId"], "nextStep.target");
  if (target.kind !== "agent") throw new Error("nextStep.target.kind is unsupported");
  return { kind: "agent", agentId: text(target.agentId, "nextStep.target.agentId", 256) };
}

function orchestratorState(value: unknown): OrchestratorState {
  const state = record(value, "state");
  exactKeys(state, [
    "schemaVersion", "goal", "tasks", "acceptedEvidence", "unresolvedQuestions"
  ], "OrchestratorState@1");
  if (state.schemaVersion !== "OrchestratorState@1" ||
    !Array.isArray(state.tasks) || state.tasks.length > 32) {
    throw new Error("OrchestratorState@1 is unsupported");
  }
  const tasks = state.tasks.map((item, index) => {
    const task = record(item, `state.tasks[${index}]`);
    exactKeys(task, [
      "taskId", "objective", "status", "assignedAgentId", "summary"
    ], `state.tasks[${index}]`, ["assignedAgentId", "summary"]);
    if (task.status !== "pending" && task.status !== "active" &&
      task.status !== "completed" && task.status !== "blocked") {
      throw new Error(`state.tasks[${index}].status is unsupported`);
    }
    return {
      taskId: text(task.taskId, `state.tasks[${index}].taskId`, 128),
      objective: text(task.objective, `state.tasks[${index}].objective`, 2_048),
      status: task.status,
      ...(task.assignedAgentId === undefined
        ? {}
        : {
            assignedAgentId: text(
              task.assignedAgentId,
              `state.tasks[${index}].assignedAgentId`,
              256
            )
          }),
      ...(task.summary === undefined
        ? {}
        : { summary: text(task.summary, `state.tasks[${index}].summary`, 2_048) })
    } satisfies OrchestratorTask;
  });
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new Error("OrchestratorState@1 taskId values must be unique");
  }
  return {
    schemaVersion: "OrchestratorState@1",
    goal: text(state.goal, "state.goal", MAX_TEXT),
    tasks,
    acceptedEvidence: stringList(state.acceptedEvidence, "state.acceptedEvidence"),
    unresolvedQuestions: stringList(state.unresolvedQuestions, "state.unresolvedQuestions")
  };
}

function runResultDestination(value: unknown): RunResultDestination {
  const destination = record(value, "resultDestination");
  exactKeys(destination, [
    "schemaVersion", "destinationId", "delivery"
  ], "RunResultDestination@2");
  if (destination.schemaVersion !== "RunResultDestination@2") {
    throw new Error("RunResultDestination@2 is unsupported");
  }
  const delivery = record(destination.delivery, "resultDestination.delivery");
  exactKeys(delivery, ["kind", "address"], "resultDestination.delivery");
  const address = record(delivery.address, "resultDestination.delivery.address");
  const entries = Object.entries(address);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error("resultDestination.delivery.address must contain 1 to 16 entries");
  }
  return {
    schemaVersion: "RunResultDestination@2",
    destinationId: text(destination.destinationId, "resultDestination.destinationId", 256),
    delivery: {
      kind: text(delivery.kind, "resultDestination.delivery.kind", 128),
      address: Object.fromEntries(entries.map(([key, entry]) => [
        text(key, "resultDestination.delivery.address key", 128),
        text(entry, `resultDestination.delivery.address.${key}`, 2_048)
      ]))
    }
  };
}

function decisionMandate(value: unknown): RunDecisionMandate {
  const mandate = record(value, "nextStep.mandate");
  if (mandate.kind === "objective") {
    exactKeys(mandate, ["kind", "objective"], "nextStep.mandate");
    return { kind: "objective", objective: text(mandate.objective, "nextStep.mandate.objective", MAX_TEXT) };
  }
  exactKeys(mandate, ["kind", "workflowRef", "inputs"], "nextStep.mandate");
  if (mandate.kind !== "workflow") throw new Error("nextStep.mandate.kind is unsupported");
  const inputs = record(mandate.inputs, "nextStep.mandate.inputs");
  if (Buffer.byteLength(JSON.stringify(inputs), "utf8") > MAX_INPUT_BYTES) {
    throw new Error(`nextStep.mandate.inputs must be at most ${MAX_INPUT_BYTES} bytes`);
  }
  return {
    kind: "workflow",
    workflowRef: text(mandate.workflowRef, "nextStep.mandate.workflowRef", 256),
    inputs
  };
}

function optionalText(
  value: Readonly<Record<string, unknown>>,
  field: string
): Readonly<Record<string, string>> {
  return value[field] === undefined ? {} : { [field]: text(value[field], `receipt.${field}`, 256) };
}

function jsonRecord(input: string, field: string): Readonly<Record<string, unknown>> {
  try {
    return record(JSON.parse(input) as unknown, field);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${field} must be one JSON object`);
    throw error;
  }
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
  optional: readonly string[] = []
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${field} has unknown field: ${unknown}`);
  const missing = allowed.find((key) => !optional.includes(key) && !(key in value));
  if (missing !== undefined) throw new Error(`${field} is missing field: ${missing}`);
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST ||
    value.some((item) => typeof item !== "string" || item.trim() === "" || item.length > 2_048)) {
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

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function iso(value: unknown, field: string): string {
  const timestamp = text(value, field, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be RFC3339`);
  return new Date(timestamp).toISOString();
}
