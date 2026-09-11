import { assertSpecCompatibility } from "../spec/registry.js";
import { boundedContractValue, contractRecord } from "./contract-codec.js";
import { parseRunOutputs, type AgentTurnOutput } from "./result-contract.js";
import { parseStewardRunDecisionV3, type StewardRunDecisionV3 } from "./run-contract-v3.js";

type WithOutputs<T> = T extends { readonly finish: infer F }
  ? Omit<T, "schemaVersion" | "finish"> & {
      readonly schemaVersion: "RunDecision@4";
      readonly finish: F & { readonly outputs?: readonly AgentTurnOutput[] };
    }
  : Omit<T, "schemaVersion"> & { readonly schemaVersion: "RunDecision@4" };

export type StewardRunDecisionV4 = WithOutputs<StewardRunDecisionV3>;
// V4 adds only bounded finish.outputs; the V3 action grammar remains authoritative.
export function parseStewardRunDecisionV4(value: unknown): StewardRunDecisionV4 {
  const input = contractRecord(value, "RunDecision@4");
  assertSpecCompatibility("spec:rollerskate/run-decision@4", input.schemaVersion, {
    kind: "result-contract"
  });
  if (input.schemaVersion !== "RunDecision@4") throw new Error("RunDecision@4 schemaVersion is required");
  const finish = input.action === "finish" ? contractRecord(input.finish, "finish") : undefined;
  const { outputs, ...baseFinish } = finish ?? {};
  const parsed = parseStewardRunDecisionV3({
    ...input,
    schemaVersion: "RunDecision@3",
    ...(finish === undefined ? {} : { finish: baseFinish })
  });
  if (parsed.action === "finish") return {
    ...parsed,
    schemaVersion: "RunDecision@4",
    finish: { ...parsed.finish, ...(outputs === undefined ? {} : {
      outputs: parseRunOutputs(boundedContractValue(outputs, "finish.outputs"))
    }) }
  };
  return { ...parsed, schemaVersion: "RunDecision@4" };
}
