import { assertSpecCompatibility } from "../spec/registry.js";
import { contractRecord, contractStringList, contractText, exactContractKeys } from "./contract-codec.js";
import { parseAcceptanceChecks, type AcceptanceCheck } from "./acceptance.js";
import { parseStewardRunDecisionV5, type StewardRunDecisionV5 } from "./run-contract-v5.js";

type Version6<T> = T extends unknown ? Omit<T, "schemaVersion" | "checkedAcceptance"> & {
  readonly schemaVersion: "RunDecision@6";
  readonly checkedAcceptance: readonly AcceptanceCheck[];
} : never;
export interface NetworkCapabilityRequest {
  readonly kind: "network";
  readonly acceptanceIds: readonly string[];
  readonly targets: readonly string[];
  readonly reason: string;
}
export type StewardRunDecisionV6 = Version6<StewardRunDecisionV5> | (
  Omit<Version6<Extract<StewardRunDecisionV5, {action: "needs_human"}>>, "action"> & {
    readonly action: "request_capability";
    readonly capability: NetworkCapabilityRequest;
  }
);
export function parseStewardRunDecisionV6(value: unknown): StewardRunDecisionV6 {
  const input = contractRecord(value, "RunDecision@6");
  assertSpecCompatibility("spec:rollerskate/run-decision@6", input.schemaVersion, {kind: "result-contract"});
  const checkedAcceptance = parseAcceptanceChecks(input.checkedAcceptance);
  if (input.action === "request_capability") {
    exactContractKeys(input, ["schemaVersion", "expectedRunVersion", "rationale", "checkedAcceptance", "state", "action", "capability"], "RunDecision@6");
    const c = contractRecord(input.capability, "capability");
    exactContractKeys(c, ["kind", "acceptanceIds", "targets", "reason"], "capability");
    if (c.kind !== "network") throw new Error("Unsupported capability kind");
    const { capability: _, ...rest } = input;
    const base = parseStewardRunDecisionV5({...rest, schemaVersion: "RunDecision@5", checkedAcceptance: [], action: "needs_human"});
    return {...base, schemaVersion: "RunDecision@6", checkedAcceptance, action: "request_capability", capability: {
      kind: "network", acceptanceIds: contractStringList(c.acceptanceIds, "acceptanceIds", {minimum: 1}),
      targets: contractStringList(c.targets, "targets", {minimum: 1, maximum: 20}), reason: contractText(c.reason, "reason", 4096)
    }};
  }
  return {...parseStewardRunDecisionV5({...input, schemaVersion: "RunDecision@5", checkedAcceptance: []}), schemaVersion: "RunDecision@6", checkedAcceptance};
}
