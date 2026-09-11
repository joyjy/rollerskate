import { assertSpecCompatibility } from "../spec/registry.js";
import { contractRecord, contractText, exactContractKeys } from "./contract-codec.js";
import { parseStewardRunDecisionV4, type StewardRunDecisionV4 } from "./run-contract-v4.js";

type Version5<T> = T extends unknown ? Omit<T,"schemaVersion"> & {readonly schemaVersion:"RunDecision@5"} : never;
export type StewardRunDecisionV5 = Version5<StewardRunDecisionV4> | (
  Omit<Version5<Extract<StewardRunDecisionV4,{action:"needs_human"}>>,"action"> & {
    readonly action:"ask_human";
    readonly question:string;
  }
);

export function parseStewardRunDecisionV5(value: unknown): StewardRunDecisionV5 {
  const input = contractRecord(value,"RunDecision@5");
  assertSpecCompatibility("spec:rollerskate/run-decision@5",input.schemaVersion,{kind:"result-contract"});
  if (input.action === "ask_human") {
    exactContractKeys(input,["schemaVersion","expectedRunVersion","rationale","checkedAcceptance","state","action","question"],"RunDecision@5");
    const {question,...rest} = input;
    const base = parseStewardRunDecisionV4({...rest,schemaVersion:"RunDecision@4",action:"needs_human"});
    if (base.action !== "needs_human") throw new Error("Invalid human question");
    return {...base,schemaVersion:"RunDecision@5",action:"ask_human",question:contractText(question,"question",4096)};
  }
  return {...parseStewardRunDecisionV4({...input,schemaVersion:"RunDecision@4"}),schemaVersion:"RunDecision@5"};
}
