import type {
  OrchestratorState,
  OrchestratorTask,
  RunDecisionMandate,
  RunDecisionTarget,
  RunResultDestination
} from "./caller-contract.js";
import {
  parseRunAuthorityEnvelope,
  type RunAuthorityEnvelope
} from "./admission-contract.js";
import {
  boundedContractValue,
  contractInteger,
  contractRecord,
  contractStringList,
  contractText,
  exactContractKeys
} from "./contract-codec.js";
import type { RunSourceKind } from "./source-contract.js";
import { assertSpecCompatibility } from "../spec/registry.js";

export interface StewardOrchestratorBindingV3 {
  readonly schemaVersion: "OrchestratorBinding@3";
  readonly mode: "caller";
  readonly callerRef: { readonly kind: "owner"; readonly principalId: string };
  readonly orchestratorRef: { readonly kind: "agent"; readonly agentId: string };
  readonly decisionContractId: "run-decision@3";
  readonly deliveryPolicy: "internal-with-manual-fallback";
  readonly admissionDigest: string;
  readonly authority: RunAuthorityEnvelope;
  readonly resultDestination?: RunResultDestination;
}

interface StewardRunDecisionV3Base {
  readonly schemaVersion: "RunDecision@3";
  readonly expectedRunVersion: number;
  readonly rationale: string;
  readonly checkedAcceptance: readonly string[];
  readonly state: OrchestratorState;
}

export interface StewardNextStepRunDecisionV3 extends StewardRunDecisionV3Base {
  readonly action: "next_step";
  readonly nextStep: {
    readonly target: RunDecisionTarget;
    readonly mandate: RunDecisionMandate;
  };
}

export interface StewardAwaitSourceRunDecisionV3 extends StewardRunDecisionV3Base {
  readonly action: "await_source";
  readonly awaitSource: {
    readonly sourceKind: RunSourceKind;
    readonly templateId: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface StewardFinishRunDecisionV3 extends StewardRunDecisionV3Base {
  readonly action: "finish";
  readonly finish: {
    readonly scope: "cycle" | "run";
    readonly outcome: "succeeded" | "failed";
    readonly summary: string;
  };
}

export interface StewardNeedsHumanRunDecisionV3 extends StewardRunDecisionV3Base {
  readonly action: "needs_human";
}

export type StewardRunDecisionV3 =
  | StewardNextStepRunDecisionV3
  | StewardAwaitSourceRunDecisionV3
  | StewardFinishRunDecisionV3
  | StewardNeedsHumanRunDecisionV3;

export function parseStewardOrchestratorBindingV3(
  value: unknown
): StewardOrchestratorBindingV3 {
  const input = contractRecord(value, "OrchestratorBinding@3");
  assertSpecCompatibility(
    "spec:rollerskate/orchestrator-binding@3",
    input.schemaVersion,
    { kind: "contract" }
  );
  exactContractKeys(input, [
    "schemaVersion", "mode", "callerRef", "orchestratorRef", "decisionContractId",
    "deliveryPolicy", "admissionDigest", "authority", "resultDestination"
  ], "OrchestratorBinding@3", ["resultDestination"]);
  const caller = contractRecord(input.callerRef, "callerRef");
  exactContractKeys(caller, ["kind", "principalId"], "callerRef");
  const orchestrator = contractRecord(input.orchestratorRef, "orchestratorRef");
  exactContractKeys(orchestrator, ["kind", "agentId"], "orchestratorRef");
  if (input.schemaVersion !== "OrchestratorBinding@3" || input.mode !== "caller" ||
    caller.kind !== "owner" || orchestrator.kind !== "agent" ||
    input.decisionContractId !== "run-decision@3" ||
    input.deliveryPolicy !== "internal-with-manual-fallback") {
    throw new Error("OrchestratorBinding@3 is unsupported");
  }
  assertSpecCompatibility(
    "spec:rollerskate/run-decision@3",
    input.decisionContractId,
    { kind: "result-contract" }
  );
  return {
    schemaVersion: "OrchestratorBinding@3",
    mode: "caller",
    callerRef: {
      kind: "owner",
      principalId: contractText(caller.principalId, "callerRef.principalId", 256)
    },
    orchestratorRef: {
      kind: "agent",
      agentId: contractText(orchestrator.agentId, "orchestratorRef.agentId", 256)
    },
    decisionContractId: "run-decision@3",
    deliveryPolicy: "internal-with-manual-fallback",
    admissionDigest: digest(input.admissionDigest, "admissionDigest"),
    authority: parseRunAuthorityEnvelope(input.authority),
    ...(input.resultDestination === undefined
      ? {}
      : { resultDestination: resultDestination(input.resultDestination) })
  };
}

export function parseStewardRunDecisionV3(value: unknown): StewardRunDecisionV3 {
  const input = contractRecord(value, "RunDecision@3");
  assertSpecCompatibility("spec:rollerskate/run-decision@3", input.schemaVersion, {
    kind: "result-contract"
  });
  if (input.schemaVersion !== "RunDecision@3") {
    throw new Error("RunDecision@3 schemaVersion is required");
  }
  const common = {
    schemaVersion: "RunDecision@3" as const,
    expectedRunVersion: contractInteger(
      input.expectedRunVersion,
      "expectedRunVersion",
      1,
      Number.MAX_SAFE_INTEGER
    ),
    rationale: contractText(input.rationale, "rationale", 4_096),
    checkedAcceptance: contractStringList(input.checkedAcceptance, "checkedAcceptance"),
    state: orchestratorState(input.state)
  };
  if (input.action === "next_step") {
    exactContractKeys(input, commonKeys("nextStep"), "RunDecision@3");
    const nextStep = contractRecord(input.nextStep, "nextStep");
    exactContractKeys(nextStep, ["target", "mandate"], "nextStep");
    return {
      ...common,
      action: "next_step",
      nextStep: { target: target(nextStep.target), mandate: mandate(nextStep.mandate) }
    };
  }
  if (input.action === "await_source") {
    exactContractKeys(input, commonKeys("awaitSource"), "RunDecision@3");
    const source = contractRecord(input.awaitSource, "awaitSource");
    exactContractKeys(source, ["sourceKind", "templateId", "parameters"], "awaitSource");
    if (source.sourceKind !== "schedule" && source.sourceKind !== "subscription" &&
      source.sourceKind !== "continuous_subscription") {
      throw new Error("awaitSource.sourceKind is unsupported");
    }
    return {
      ...common,
      action: "await_source",
      awaitSource: {
        sourceKind: source.sourceKind,
        templateId: contractText(source.templateId, "awaitSource.templateId", 256),
        parameters: contractRecord(
          boundedContractValue(source.parameters, "awaitSource.parameters"),
          "awaitSource.parameters"
        )
      }
    };
  }
  if (input.action === "finish") {
    exactContractKeys(input, commonKeys("finish"), "RunDecision@3");
    const finish = contractRecord(input.finish, "finish");
    exactContractKeys(finish, ["scope", "outcome", "summary"], "finish");
    if ((finish.scope !== "cycle" && finish.scope !== "run") ||
      (finish.outcome !== "succeeded" && finish.outcome !== "failed")) {
      throw new Error("RunDecision@3 finish is unsupported");
    }
    return {
      ...common,
      action: "finish",
      finish: {
        scope: finish.scope,
        outcome: finish.outcome,
        summary: contractText(finish.summary, "finish.summary", 4_096)
      }
    };
  }
  if (input.action !== "needs_human") {
    throw new Error("RunDecision@3 action is unsupported");
  }
  exactContractKeys(input, commonKeys(), "RunDecision@3");
  return { ...common, action: "needs_human" };
}

function commonKeys(extra?: string): readonly string[] {
  return [
    "schemaVersion", "action", "expectedRunVersion", "rationale",
    "checkedAcceptance", "state", ...(extra === undefined ? [] : [extra])
  ];
}

function target(value: unknown): RunDecisionTarget {
  const input = contractRecord(value, "nextStep.target");
  if (input.kind === "self") {
    exactContractKeys(input, ["kind"], "nextStep.target");
    return { kind: "self" };
  }
  exactContractKeys(input, ["kind", "agentId"], "nextStep.target");
  if (input.kind !== "agent") throw new Error("nextStep.target.kind is unsupported");
  return {
    kind: "agent",
    agentId: contractText(input.agentId, "nextStep.target.agentId", 256)
  };
}

function mandate(value: unknown): RunDecisionMandate {
  const input = contractRecord(value, "nextStep.mandate");
  if (input.kind === "objective") {
    exactContractKeys(input, ["kind", "objective"], "nextStep.mandate");
    return {
      kind: "objective",
      objective: contractText(input.objective, "nextStep.mandate.objective")
    };
  }
  exactContractKeys(input, ["kind", "workflowRef", "inputs"], "nextStep.mandate");
  if (input.kind !== "workflow") throw new Error("nextStep.mandate.kind is unsupported");
  return {
    kind: "workflow",
    workflowRef: contractText(input.workflowRef, "nextStep.mandate.workflowRef", 256),
    inputs: contractRecord(
      boundedContractValue(input.inputs, "nextStep.mandate.inputs"),
      "nextStep.mandate.inputs"
    )
  };
}

function orchestratorState(value: unknown): OrchestratorState {
  const input = contractRecord(value, "state");
  exactContractKeys(input, [
    "schemaVersion", "goal", "tasks", "acceptedEvidence", "unresolvedQuestions"
  ], "OrchestratorState@1");
  if (input.schemaVersion !== "OrchestratorState@1" ||
    !Array.isArray(input.tasks) || input.tasks.length > 32) {
    throw new Error("OrchestratorState@1 is unsupported");
  }
  const tasks = input.tasks.map((value_, index) => {
    const task = contractRecord(value_, `state.tasks[${index}]`);
    exactContractKeys(task, [
      "taskId", "objective", "status", "assignedAgentId", "summary"
    ], `state.tasks[${index}]`, ["assignedAgentId", "summary"]);
    if (task.status !== "pending" && task.status !== "active" &&
      task.status !== "completed" && task.status !== "blocked") {
      throw new Error(`state.tasks[${index}].status is unsupported`);
    }
    return {
      taskId: contractText(task.taskId, `state.tasks[${index}].taskId`, 128),
      objective: contractText(task.objective, `state.tasks[${index}].objective`, 2_048),
      status: task.status,
      ...(task.assignedAgentId === undefined
        ? {}
        : {
            assignedAgentId: contractText(
              task.assignedAgentId,
              `state.tasks[${index}].assignedAgentId`,
              256
            )
          }),
      ...(task.summary === undefined
        ? {}
        : { summary: contractText(task.summary, `state.tasks[${index}].summary`, 2_048) })
    } satisfies OrchestratorTask;
  });
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new Error("OrchestratorState@1 taskId values must be unique");
  }
  return {
    schemaVersion: "OrchestratorState@1",
    goal: contractText(input.goal, "state.goal"),
    tasks,
    acceptedEvidence: contractStringList(input.acceptedEvidence, "state.acceptedEvidence"),
    unresolvedQuestions: contractStringList(
      input.unresolvedQuestions,
      "state.unresolvedQuestions"
    )
  };
}

function resultDestination(value: unknown): RunResultDestination {
  const input = contractRecord(value, "resultDestination");
  exactContractKeys(input, ["schemaVersion", "destinationId", "delivery"], "resultDestination");
  if (input.schemaVersion !== "RunResultDestination@2") {
    throw new Error("RunResultDestination@2 is unsupported");
  }
  const delivery = contractRecord(input.delivery, "resultDestination.delivery");
  exactContractKeys(delivery, ["kind", "address"], "resultDestination.delivery");
  const address = contractRecord(delivery.address, "resultDestination.delivery.address");
  const entries = Object.entries(address);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error("resultDestination.delivery.address must contain 1-16 entries");
  }
  return {
    schemaVersion: "RunResultDestination@2",
    destinationId: contractText(input.destinationId, "resultDestination.destinationId", 256),
    delivery: {
      kind: contractText(delivery.kind, "resultDestination.delivery.kind", 128),
      address: Object.fromEntries(entries.map(([key, nested]) => [
        contractText(key, "resultDestination.delivery.address key", 128),
        contractText(nested, `resultDestination.delivery.address.${key}`, 2_048)
      ]))
    }
  };
}

function digest(value: unknown, field: string): string {
  const result = contractText(value, field, 80);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${field} must be sha256:<hex>`);
  return result;
}
