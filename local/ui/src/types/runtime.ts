import type {
  ChatPresenceOutput,
  RuntimeAuditOutput,
  RuntimeDeliveryOutput,
  RuntimeEventOutput,
  RuntimeExecutionOutput,
  RuntimeFailureOutput,
  RuntimeInfoOutput,
  RuntimeResultEventOutput,
  RuntimeSessionOutput
} from "@/api/schema";

export type RuntimeInfo = RuntimeInfoOutput;
export type RuntimeStatus = RuntimeInfo["status"];
export type RuntimeLoopPhase = RuntimeInfo["loop"]["phase"];
export type RuntimeWorkloadState = RuntimeInfo["workload"]["state"];
export type RuntimeFailure = RuntimeFailureOutput;
export type RuntimeFailureOwner = RuntimeFailure["owner"];
export type RuntimeFailureSeverity = RuntimeFailure["severity"];
export type RuntimeFailureAction = RuntimeFailure["action"];
export type RuntimeFailureActionKind = RuntimeFailureAction["kind"];
export type RuntimeControlAvailability = RuntimeInfo["controls"];
export type RuntimeControlResult = NonNullable<RuntimeInfo["controlResult"]>;
export type RuntimeControlAction = RuntimeControlResult["kind"];
export type RuntimeControlStatus = RuntimeControlResult["status"];
export type RuntimeLoopHealth = RuntimeInfo["loop"];
export type RuntimeWorkload = RuntimeInfo["workload"];
export type RuntimeEvent = RuntimeEventOutput;
export type Causality = RuntimeEvent["causality"];
export type RuntimeExecution = RuntimeExecutionOutput;
export type RuntimeResultEvent = RuntimeResultEventOutput;
export type RuntimeSession = RuntimeSessionOutput;
export type RuntimeDelivery = RuntimeDeliveryOutput;
export type RuntimeAudit = RuntimeAuditOutput;
export type ChatPresence = ChatPresenceOutput;
