import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import { observationSchema, type Observation } from "@rollerskate/protocol";

interface PendingObservationBatch {
  readonly inputCursor: string;
  readonly nextCursor: string;
  readonly complete: boolean;
  readonly observations: readonly Observation[];
  readonly revisionUpdates: Readonly<Record<string, string>>;
}

interface VikunjaLedgerDocument {
  readonly schemaVersion: 1;
  readonly observedRevisions: Readonly<Record<string, string>>;
  readonly effects: Readonly<Record<string, unknown>>;
  readonly pendingObservation?: PendingObservationBatch;
}

export class VikunjaConnectorLedger {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public pendingObservation(cursor: string): PendingObservationBatch | undefined {
    const document = this.#read();
    const pending = document.pendingObservation;
    if (pending === undefined) return undefined;
    if (pending.inputCursor === cursor) return pending;
    if (pending.nextCursor === cursor) {
      const { pendingObservation: _pendingObservation, ...acknowledged } = document;
      this.#write({
        ...acknowledged,
        observedRevisions: {
          ...document.observedRevisions,
          ...pending.revisionUpdates
        }
      });
      return undefined;
    }
    throw new Error("Vikunja observation cursor does not acknowledge the pending batch");
  }

  public observedRevision(externalId: string): string | undefined {
    return this.#read().observedRevisions[externalId];
  }

  public savePendingObservation(batch: PendingObservationBatch): void {
    const document = this.#read();
    if (document.pendingObservation !== undefined) {
      throw new Error("Vikunja observation batch is already pending acknowledgement");
    }
    this.#write({ ...document, pendingObservation: batch });
  }

  #read(): VikunjaLedgerDocument {
    if (!existsSync(this.#path)) return emptyDocument();
    if (lstatSync(this.#path).isSymbolicLink() || !statSync(this.#path).isFile()) {
      throw new Error("Vikunja Connector ledger must be a regular file");
    }
    if ((statSync(this.#path).mode & 0o077) !== 0) {
      throw new Error("Vikunja Connector ledger must be private to the owner");
    }
    return parseDocument(JSON.parse(readFileSync(this.#path, "utf8") as string) as unknown);
  }

  #write(document: VikunjaLedgerDocument): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    if (existsSync(this.#path) && lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("Vikunja Connector ledger must not be a symlink");
    }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

function emptyDocument(): VikunjaLedgerDocument {
  return { schemaVersion: 1, observedRevisions: {}, effects: {} };
}

function parseDocument(value: unknown): VikunjaLedgerDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !isStringRecord(value.observedRevisions) || !isRecord(value.effects)) {
    throw new Error("Vikunja Connector ledger has an unsupported schema");
  }
  const pending = value.pendingObservation === undefined
    ? undefined
    : parsePendingObservation(value.pendingObservation);
  return {
    schemaVersion: 1,
    observedRevisions: value.observedRevisions,
    effects: value.effects,
    ...(pending === undefined ? {} : { pendingObservation: pending })
  };
}

function parsePendingObservation(value: unknown): PendingObservationBatch {
  if (!isRecord(value) || typeof value.inputCursor !== "string" ||
    typeof value.nextCursor !== "string" || typeof value.complete !== "boolean" ||
    !Array.isArray(value.observations) || !isStringRecord(value.revisionUpdates)) {
    throw new Error("Vikunja pending observation batch is invalid");
  }
  return {
    inputCursor: value.inputCursor,
    nextCursor: value.nextCursor,
    complete: value.complete,
    observations: value.observations.map((item) => observationSchema.parse(item)),
    revisionUpdates: value.revisionUpdates
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
