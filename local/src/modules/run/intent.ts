import { createHash } from "node:crypto";
import { contractRecord, exactContractKeys, contractText, contractInteger, boundedContractValue, stableContractJson } from "../steward/contract-codec.js";
import { parseRunIntent, type RunIntent } from "../steward/admission-contract.js";

export interface DeterministicRunIntent {
  readonly schemaVersion: "RunIntent@2";
  readonly requestId: string;
  readonly title: string;
  readonly resultDestinationRef?: string;
  readonly maxWaitMilliseconds?: number;
  readonly work: { readonly kind: "command"; readonly executable: string; readonly args: readonly string[]; readonly cwd: string }
    | { readonly kind: "observe"; readonly mode: "until" | "continuous"; readonly sourceRef: string; readonly input: unknown };
}

export type WorkRunIntent = RunIntent | DeterministicRunIntent;

/** Agent intents retain the established contract; v2 adds explicitly deterministic work. */
export function parseWorkRunIntent(value: unknown): WorkRunIntent {
  const input = contractRecord(value, "Run intent");
  if (input.schemaVersion === "RunIntent@1") return parseRunIntent(value);
  exactContractKeys(input, ["schemaVersion", "requestId", "title", "resultDestinationRef", "maxWaitMilliseconds", "work"],
    "RunIntent@2", ["resultDestinationRef", "maxWaitMilliseconds"]);
  if (input.schemaVersion !== "RunIntent@2") throw new Error("Expected RunIntent@1 or RunIntent@2");
  const work = contractRecord(input.work, "work");
  let parsedWork: DeterministicRunIntent["work"];
  if (work.kind === "command") {
    exactContractKeys(work, ["kind", "executable", "args", "cwd"], "work");
    if (!Array.isArray(work.args) || work.args.length > 1024 || work.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error("work.args must contain at most 1024 NUL-free strings");
    }
    const executable = contractText(work.executable, "work.executable", 4096);
    const cwd = contractText(work.cwd, "work.cwd", 4096);
    if (executable.includes("\0") || cwd.includes("\0")) throw new Error("Executable and cwd must not contain NUL");
    parsedWork = { kind: "command", executable, args: work.args as string[], cwd };
  } else if (work.kind === "observe") {
    exactContractKeys(work, ["kind", "mode", "sourceRef", "input"], "work", ["mode"]);
    if (work.mode !== undefined && work.mode !== "until" && work.mode !== "continuous") throw new Error("Observe mode must be until or continuous");
    parsedWork = { kind: "observe", mode: work.mode === "continuous" ? "continuous" : "until", sourceRef: contractText(work.sourceRef, "work.sourceRef", 256),
      input: boundedContractValue(work.input, "work.input") };
  } else throw new Error("Unknown work tool; expected command or observe (Agent work uses RunIntent@1)");
  const continuous = parsedWork.kind === "observe" && parsedWork.mode === "continuous";
  if (continuous && input.maxWaitMilliseconds !== undefined) throw new Error("Continuous observation has no wait deadline; omit maxWaitMilliseconds");
  const parsed: DeterministicRunIntent = {
    schemaVersion: "RunIntent@2", requestId: contractText(input.requestId, "requestId", 256),
    title: contractText(input.title, "title", 120),
    ...(input.resultDestinationRef === undefined ? {} : { resultDestinationRef: contractText(input.resultDestinationRef, "resultDestinationRef", 256) }),
    ...(continuous ? {} : {maxWaitMilliseconds: contractInteger(input.maxWaitMilliseconds, "maxWaitMilliseconds", 1000, 31 * 86_400_000)}), work: parsedWork
  };
  if (Buffer.byteLength(JSON.stringify(parsed)) > 65_536) throw new Error("Run intent exceeds 65536 bytes");
  return parsed;
}

export function workDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableContractJson(value)).digest("hex")}`;
}

export function deterministicRunId(requestId: string): string {
  return `run_d_${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}

export function isDeterministicRunId(id: string): boolean { return /^run_d_[0-9a-f]{32}$/u.test(id); }
