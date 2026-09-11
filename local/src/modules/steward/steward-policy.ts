import { createHash } from "node:crypto";
import { contractInteger, contractRecord, contractText, exactContractKeys,
  stableContractJson } from "./contract-codec.js";

export interface StewardPolicy {
  readonly schemaVersion: "StewardPolicy@1";
  readonly entries: readonly { readonly agentId: string; readonly weight: number }[];
}

export interface StewardSelection {
  readonly agentId: string;
  readonly policyDigest: string;
  readonly bucket: number;
}

export function parseStewardPolicy(value: unknown): StewardPolicy {
  const input = contractRecord(value, "StewardPolicy@1");
  exactContractKeys(input, ["schemaVersion", "entries"], "StewardPolicy@1");
  if (input.schemaVersion !== "StewardPolicy@1" || !Array.isArray(input.entries) ||
    input.entries.length < 1 || input.entries.length > 16) throw new Error("Invalid StewardPolicy@1");
  const entries = input.entries.map((value) => {
    const entry = contractRecord(value, "policy entry");
    exactContractKeys(entry, ["agentId", "weight"], "policy entry");
    return { agentId: contractText(entry.agentId, "agentId", 256),
      weight: contractInteger(entry.weight, "weight", 1, 100) };
  });
  if (new Set(entries.map((entry) => entry.agentId)).size !== entries.length ||
    entries.reduce((total, entry) => total + entry.weight, 0) !== 100) {
    throw new Error("Steward policy requires unique agentIds and weights totaling 100");
  }
  return { schemaVersion: "StewardPolicy@1", entries };
}

export function selectSteward(policy: StewardPolicy, requestId: string): StewardSelection {
  const bucket = createHash("sha256").update(`steward-policy@1:${requestId}`)
    .digest().readUInt32BE(0) % 100;
  let upper = 0;
  for (const entry of policy.entries) {
    upper += entry.weight;
    if (bucket < upper) return { agentId: entry.agentId, bucket,
      policyDigest: `sha256:${createHash("sha256").update(stableContractJson(policy)).digest("hex")}` };
  }
  throw new Error("Invalid steward policy weights");
}

export function parseStewardSelection(value: unknown): StewardSelection {
  const input = contractRecord(value, "steward selection");
  exactContractKeys(input, ["agentId", "policyDigest", "bucket"], "steward selection");
  const policyDigest = contractText(input.policyDigest, "policyDigest", 80);
  if (!/^sha256:[0-9a-f]{64}$/u.test(policyDigest)) throw new Error("Invalid policyDigest");
  return { agentId: contractText(input.agentId, "agentId", 256), policyDigest,
    bucket: contractInteger(input.bucket, "bucket", 0, 99) };
}

export function supportsStewardClient(client: string): boolean {
  return ["codex", "kimi-code", "pi"].includes(client);
}
