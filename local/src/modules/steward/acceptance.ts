import { createHash } from "node:crypto";
import { contractRecord, contractStringList, contractText, exactContractKeys, stableContractJson } from "./contract-codec.js";

export interface AcceptanceContract {
  readonly sourceDigest: string;
  readonly items: readonly { readonly id: string; readonly text: string }[];
}
export interface AcceptanceCheck {
  readonly id: string;
  readonly status: "pass" | "fail" | "unknown";
  readonly evidenceRefs: readonly string[];
}
export function acceptanceContract(acceptance: readonly string[], contextRefs: readonly string[]): AcceptanceContract {
  const sourceDigest = `sha256:${createHash("sha256").update(stableContractJson({ acceptance, contextRefs })).digest("hex")}`;
  return { sourceDigest, items: acceptance.map((text, i) => ({ id: `a${i + 1}`, text })) };
}
export function parseAcceptanceContract(value: unknown): AcceptanceContract {
  const v = contractRecord(value, "acceptanceContract");
  exactContractKeys(v, ["sourceDigest", "items"], "acceptanceContract");
  const sourceDigest = contractText(v.sourceDigest, "sourceDigest", 80);
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceDigest)) throw new Error("Invalid acceptance source digest");
  if (!Array.isArray(v.items) || !v.items.length || v.items.length > 100) throw new Error("Invalid acceptance items");
  const items = v.items.map((value, i) => {
    const item = contractRecord(value, "acceptance item");
    exactContractKeys(item, ["id", "text"], "acceptance item");
    if (item.id !== `a${i + 1}`) throw new Error("Acceptance IDs must match source order");
    return { id: item.id, text: contractText(item.text, "acceptance text") };
  });
  return { sourceDigest, items };
}
export function parseAcceptanceChecks(value: unknown): readonly AcceptanceCheck[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("checkedAcceptance must be an array of at most 100 checks");
  const checks = value.map((value): AcceptanceCheck => {
    const v = contractRecord(value, "acceptance check");
    exactContractKeys(v, ["id", "status", "evidenceRefs"], "acceptance check");
    if (v.status !== "pass" && v.status !== "fail" && v.status !== "unknown") throw new Error("Invalid acceptance status");
    return { id: contractText(v.id, "acceptance id", 32), status: v.status,
      evidenceRefs: contractStringList(v.evidenceRefs, "evidenceRefs", { maximum: 20 }) };
  });
  if (new Set(checks.map(c => c.id)).size !== checks.length) throw new Error("Duplicate acceptance check");
  return checks;
}
export function assertAcceptanceSatisfied(contract: AcceptanceContract, checks: readonly AcceptanceCheck[], unresolved: readonly string[]): void {
  if (unresolved.length || checks.length !== contract.items.length || contract.items.some(item => {
    const check = checks.find(c => c.id === item.id);
    return check?.status !== "pass" || check.evidenceRefs.length === 0;
  })) throw new Error("acceptance_incomplete: every original acceptance item requires pass and evidence; unresolved questions must be empty");
}
