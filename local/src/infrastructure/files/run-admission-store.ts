import { requireLocalId } from "../../core/id.js";
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deterministicRunId, isDeterministicRunId, parseWorkRunIntent, workDigest, type DeterministicRunIntent } from "../../modules/run/intent.js";
import { contractRecord, exactContractKeys, contractText, contractIso } from "../../modules/steward/contract-codec.js";

export interface RunAdmission {
  readonly schemaVersion: "RunAdmission@1";
  readonly runId: string;
  readonly createdAt: string;
  readonly sourceId: string;
  readonly intent: DeterministicRunIntent;
  readonly planDigest: string;
  readonly intentDigest: string;
}

/** Immutable admission is the identity/authority owner; lifecycle is read from existing executors and sources. */
export class RunAdmissionStore {
  constructor(private readonly runtimeDirectory: string) {}
  private path(id: string): string {
    if (!isDeterministicRunId(id)) throw new Error("Invalid deterministic Run identity");
    return join(this.runtimeDirectory, "runs", id, "admission.json");
  }
  has(id: string): boolean { return existsSync(this.path(id)); }
  reserve(admission: RunAdmission): void {
    const path = this.path(admission.runId);
    mkdirSync(join(this.runtimeDirectory, "runs"), { recursive: true, mode: 0o700 });
    // The exclusive directory also fences an interrupted admission whose file was never finished.
    mkdirSync(join(this.runtimeDirectory, "runs", admission.runId), { mode: 0o700 });
    writeFileSync(path, JSON.stringify(admission), { flag: "wx", mode: 0o600 });
  }
  read(id: string): RunAdmission {
    const fd = openSync(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 131_072) throw new Error("Run admission must be a bounded regular file");
      const input = contractRecord(JSON.parse(readFileSync(fd, "utf8")), "Run admission");
      exactContractKeys(input, ["schemaVersion", "runId", "sourceId", "createdAt", "intent", "planDigest", "intentDigest"], "Run admission");
      const intent = parseWorkRunIntent(input.intent);
      if (input.schemaVersion !== "RunAdmission@1" || input.runId !== id || intent.schemaVersion !== "RunIntent@2" ||
        deterministicRunId(intent.requestId) !== id || workDigest(intent) !== input.intentDigest) throw new Error("Run admission identity mismatch");
      return { schemaVersion: "RunAdmission@1", runId: id, sourceId: requireLocalId(contractText(input.sourceId, "sourceId", 64), "sub", "sourceId"), intent, createdAt: contractIso(input.createdAt, "createdAt"),
        intentDigest: String(input.intentDigest), planDigest: contractText(input.planDigest, "planDigest", 80) };
    } finally { closeSync(fd); }
  }
  list(): RunAdmission[] {
    const root = join(this.runtimeDirectory, "runs");
    if (!existsSync(root)) return [];
    return readdirSync(root).filter(isDeterministicRunId).filter(id => this.has(id)).map(id => this.read(id));
  }
}
