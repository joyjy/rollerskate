import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  DETERMINISTIC_ACTION_RECEIPT_SCHEMA,
  deterministicActionReceiptId,
  parseDeterministicApplicationActionReceipt,
  parseProactiveTarget,
  proactiveTargetDigest,
  type ApplicationActionProactiveTarget,
  type DeterministicApplicationActionReceipt,
  type DeterministicApplicationActionRuntime
} from "../../modules/proactive/target.js";
import type { TriggerSourceRef } from "../../modules/proactive/target.js";
import {
  boundedContractValue,
  stableContractJson
} from "../../modules/steward/contract-codec.js";

export interface DeterministicApplicationActionResult {
  readonly status: "succeeded" | "skipped";
  readonly summary?: string;
  readonly output?: unknown;
}

export interface DeterministicApplicationActionRegistration {
  readonly ref: string;
  readonly inputSchema: string;
  readonly parseInput: (value: unknown) => unknown;
  readonly executeInTransaction: (input: {
    readonly database: DatabaseSync;
    readonly source: TriggerSourceRef;
    readonly occurrenceKey: string;
    readonly observation: unknown;
    readonly actionInput: unknown;
    readonly at: string;
  }) => DeterministicApplicationActionResult;
}

interface ReceiptRow {
  readonly receipt_json: string;
}

export class DeterministicApplicationActionRegistry
implements DeterministicApplicationActionRuntime {
  readonly #database: DatabaseSync;
  readonly #registrations: ReadonlyMap<string, DeterministicApplicationActionRegistration>;

  public constructor(
    database: DatabaseSync,
    registrations: readonly DeterministicApplicationActionRegistration[] = []
  ) {
    this.#database = database;
    const byRef = new Map<string, DeterministicApplicationActionRegistration>();
    for (const registration of registrations) {
      const ref = registeredRef(registration.ref);
      inputSchema(registration.inputSchema);
      if (byRef.has(ref)) throw new Error(`Duplicate deterministic action registration: ${ref}`);
      byRef.set(ref, registration);
    }
    this.#registrations = byRef;
  }

  public compileTarget(actionRef: string, input: unknown): ApplicationActionProactiveTarget {
    const registration = this.#require(actionRef);
    return parseProactiveTarget({
      schemaVersion: "ProactiveTarget@1",
      kind: "application_action",
      actionRef: registration.ref,
      registrationDigest: registrationDigest(registration),
      input: registration.parseInput(boundedContractValue(input, "application action input"))
    }) as ApplicationActionProactiveTarget;
  }

  public executeInTransaction(input: {
    readonly target: ApplicationActionProactiveTarget;
    readonly source: TriggerSourceRef;
    readonly occurrenceKey: string;
    readonly observation: unknown;
    readonly at: string;
  }): DeterministicApplicationActionReceipt {
    if (!this.#database.isTransaction) {
      throw new Error("deterministic application action requires an owning transaction");
    }
    const target = parseProactiveTarget(input.target, input.source);
    if (target.kind !== "application_action") {
      throw new Error("deterministic application action target is required");
    }
    const targetDigest = proactiveTargetDigest(target);
    const existing = this.#existing(input.source, input.occurrenceKey);
    if (existing !== undefined) {
      if (existing.targetDigest !== targetDigest || existing.actionRef !== target.actionRef) {
        throw new Error("deterministic action occurrence is already bound to another target");
      }
      return existing;
    }
    const completedAt = iso(input.at);
    const savepoint = "deterministic_application_action";
    let result: DeterministicApplicationActionResult | undefined;
    let failure: string | undefined;
    try {
      const registration = this.#require(target.actionRef);
      if (target.registrationDigest !== registrationDigest(registration)) {
        throw new Error("deterministic application action registry changed after admission");
      }
      const actionInput = boundedContractValue(
        registration.parseInput(target.input),
        "parsed application action input"
      );
      this.#database.exec(`SAVEPOINT ${savepoint}`);
      try {
        result = parseResult(registration.executeInTransaction({
          database: this.#database,
          source: input.source,
          occurrenceKey: input.occurrenceKey,
          observation: boundedContractValue(input.observation, "action observation"),
          actionInput,
          at: completedAt
        }));
        this.#database.exec(`RELEASE ${savepoint}`);
      } catch (error) {
        this.#database.exec(`ROLLBACK TO ${savepoint}`);
        this.#database.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    } catch (error) {
      failure = message(error);
    }
    const receipt = parseDeterministicApplicationActionReceipt({
      schemaVersion: DETERMINISTIC_ACTION_RECEIPT_SCHEMA,
      receiptId: deterministicActionReceiptId({
        source: input.source,
        occurrenceKey: input.occurrenceKey
      }),
      source: input.source,
      occurrenceKey: input.occurrenceKey,
      targetDigest,
      actionRef: target.actionRef,
      registrationDigest: target.registrationDigest,
      status: failure === undefined ? result!.status : "failed",
      ...(failure === undefined && result!.summary !== undefined
        ? { summary: result!.summary }
        : {}),
      ...(failure === undefined && result!.output !== undefined
        ? { output: result!.output }
        : {}),
      ...(failure === undefined ? {} : { error: failure }),
      completedAt
    });
    const encoded = stableContractJson(receipt);
    if (Buffer.byteLength(encoded, "utf8") > 65_536) {
      throw new Error("deterministic application action receipt exceeds 65536 bytes");
    }
    this.#database.prepare(`
      INSERT INTO deterministic_action_receipts (
        receipt_id, source_kind, source_id, definition_revision, occurrence_key,
        target_digest, action_ref, status, receipt_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.receiptId,
      input.source.kind,
      input.source.id,
      input.source.definitionRevision,
      input.occurrenceKey,
      receipt.targetDigest,
      receipt.actionRef,
      receipt.status,
      encoded,
      completedAt
    );
    return receipt;
  }

  public receipt(
    source: TriggerSourceRef,
    occurrenceKey: string
  ): DeterministicApplicationActionReceipt | undefined {
    return this.#existing(source, occurrenceKey);
  }

  #existing(
    source: TriggerSourceRef,
    occurrenceKey: string
  ): DeterministicApplicationActionReceipt | undefined {
    const row = this.#database.prepare(`
      SELECT receipt_json FROM deterministic_action_receipts
      WHERE source_kind = ? AND source_id = ? AND occurrence_key = ?
    `).get(source.kind, source.id, occurrenceKey) as ReceiptRow | undefined;
    return row === undefined
      ? undefined
      : parseDeterministicApplicationActionReceipt(JSON.parse(row.receipt_json) as unknown);
  }

  #require(ref: string): DeterministicApplicationActionRegistration {
    const registration = this.#registrations.get(registeredRef(ref));
    if (registration === undefined) {
      throw new Error(`Deterministic application action is not registered: ${ref}`);
    }
    return registration;
  }
}

export function registrationDigest(
  registration: Pick<DeterministicApplicationActionRegistration, "ref" | "inputSchema">
): string {
  return `sha256:${createHash("sha256").update(stableContractJson({
    schemaVersion: "DeterministicApplicationActionRegistration@1",
    ref: registeredRef(registration.ref),
    inputSchema: inputSchema(registration.inputSchema)
  })).digest("hex")}`;
}

function parseResult(value: DeterministicApplicationActionResult): DeterministicApplicationActionResult {
  if (value === null || typeof value !== "object" ||
    (value.status !== "succeeded" && value.status !== "skipped")) {
    throw new Error("deterministic application action returned an invalid result");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["status", "summary", "output"].includes(key))) {
    throw new Error("deterministic application action returned unknown result fields");
  }
  if (value.summary !== undefined && (
    typeof value.summary !== "string" || value.summary.trim() === "" ||
    value.summary.length > 4_096
  )) {
    throw new Error("deterministic application action summary is invalid");
  }
  return {
    status: value.status,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(value.output === undefined
      ? {}
      : { output: boundedContractValue(value.output, "application action output") })
  };
}

function registeredRef(value: string): string {
  if (!/^action:[a-z0-9][a-z0-9._/-]*@[1-9][0-9]*$/u.test(value)) {
    throw new Error("deterministic action ref must be action:<name>@<version>");
  }
  return value;
}

function inputSchema(value: string): string {
  if (value.trim() === "" || value.length > 256 || !/@[1-9][0-9]*$/u.test(value)) {
    throw new Error("deterministic action inputSchema must be a bounded versioned token");
  }
  return value;
}

function iso(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("action timestamp must be RFC 3339");
  return new Date(milliseconds).toISOString();
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
