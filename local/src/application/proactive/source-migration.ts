import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { ScheduledTaskStore } from "../../capabilities/scheduled-task/store.js";
import type { Schedule } from "../../capabilities/scheduled-task/model.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { withImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
import { requireScheduleId } from "../../capabilities/scheduled-task/model.js";
import { proactiveTargetDigest } from "../../modules/proactive/target.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";
import { loadOwnerExternalWorkflowRegistry } from "./external-workflow-registry.js";

export const PROACTIVE_SOURCE_MIGRATION_RECEIPT_SCHEMA =
  "ProactiveSourceMigrationReceipt@1";

export interface ProactiveSourceMigrationReceipt {
  readonly schemaVersion: typeof PROACTIVE_SOURCE_MIGRATION_RECEIPT_SCHEMA;
  readonly receiptId: string;
  readonly requestId: string;
  readonly sourceKind: "schedule";
  readonly sourceId: string;
  readonly fromDefinitionRevision: string;
  readonly fromDefinitionDigest: string;
  readonly toDefinitionRevision: string;
  readonly targetDigest: string;
  readonly workflowRef: string;
  readonly registrationDigest: string;
  readonly migratedAt: string;
}

export interface ExternalWorkflowScheduleMigrationResult {
  readonly schedule: Schedule;
  readonly receipt: ProactiveSourceMigrationReceipt;
  readonly status: "migrated" | "duplicate";
}

export function migrateLegacyScheduleToExternalWorkflow(
  repoRoot: string,
  input: {
    readonly scheduleId: string;
    readonly expectedRevision: number;
    readonly workflowRef: string;
    readonly requestId: string;
  },
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ExternalWorkflowScheduleMigrationResult {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const registry = loadOwnerExternalWorkflowRegistry(repoRoot, runtimeDirectory);
  const database = openRuntimeDatabase(paths.database);
  const schedules = new ScheduledTaskStore(database);
  try {
    return withImmediateTransaction(database, () => {
      const requestId = text(input.requestId, "requestId", 256);
      const existing = migrationByRequest(database, requestId);
      if (existing !== undefined) {
        if (existing.sourceId !== input.scheduleId ||
          existing.workflowRef !== input.workflowRef ||
          existing.fromDefinitionRevision !==
            `ScheduleRevision@1:${positiveInteger(input.expectedRevision, "expectedRevision")}`) {
          throw new Error("migration requestId is already bound to another request");
        }
        return {
          schedule: schedules.require(existing.sourceId),
          receipt: existing,
          status: "duplicate"
        };
      }
      requireScheduleId(input.scheduleId);
      const current = schedules.require(input.scheduleId);
      if (current.revision.schemaVersion !== "ScheduleRevision@1") {
        throw new Error("Schedule is not a legacy definition");
      }
      const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
      if (current.definition.currentRevision !== expectedRevision) {
        throw new Error(`Schedule revision conflict: ${input.scheduleId}`);
      }
      const target = registry.compileTarget(input.workflowRef);
      const migratedAt = iso(at);
      const receipt = parseMigrationReceipt({
        schemaVersion: PROACTIVE_SOURCE_MIGRATION_RECEIPT_SCHEMA,
        receiptId: migrationReceiptId(requestId),
        requestId,
        sourceKind: "schedule",
        sourceId: input.scheduleId,
        fromDefinitionRevision: `ScheduleRevision@1:${expectedRevision}`,
        fromDefinitionDigest: digest(current.revision),
        toDefinitionRevision: `ScheduleRevision@3:${expectedRevision + 1}`,
        targetDigest: proactiveTargetDigest(target),
        workflowRef: target.workflow.workflowRef,
        registrationDigest: target.workflow.registrationDigest,
        migratedAt
      });
      const schedule = schedules.migrateLegacyToExternalWorkflowInTransaction({
        scheduleId: input.scheduleId,
        expectedRevision,
        target,
        at: migratedAt
      });
      database.prepare(`
        INSERT INTO proactive_source_migration_receipts (
          receipt_id, request_id, source_kind, source_id, from_definition_revision,
          to_definition_revision, target_digest, workflow_ref, receipt_json, created_at
        ) VALUES (?, ?, 'schedule', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.receiptId,
        receipt.requestId,
        receipt.sourceId,
        receipt.fromDefinitionRevision,
        receipt.toDefinitionRevision,
        receipt.targetDigest,
        receipt.workflowRef,
        stableContractJson(receipt),
        receipt.migratedAt
      );
      return { schedule, receipt, status: "migrated" };
    });
  } finally {
    schedules.close();
    database.close();
  }
}

function migrationByRequest(
  database: DatabaseSync,
  requestId: string
): ProactiveSourceMigrationReceipt | undefined {
  const row = database.prepare(`
    SELECT receipt_json FROM proactive_source_migration_receipts WHERE request_id = ?
  `).get(requestId) as { receipt_json: string } | undefined;
  return row === undefined
    ? undefined
    : parseMigrationReceipt(JSON.parse(row.receipt_json) as unknown);
}

function parseMigrationReceipt(value: unknown): ProactiveSourceMigrationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${PROACTIVE_SOURCE_MIGRATION_RECEIPT_SCHEMA} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const keys = [
    "schemaVersion", "receiptId", "requestId", "sourceKind", "sourceId",
    "fromDefinitionRevision", "fromDefinitionDigest", "toDefinitionRevision",
    "targetDigest", "workflowRef", "registrationDigest", "migratedAt"
  ];
  if (Object.keys(input).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in input)) ||
    input.schemaVersion !== PROACTIVE_SOURCE_MIGRATION_RECEIPT_SCHEMA ||
    input.sourceKind !== "schedule") {
    throw new Error(`${PROACTIVE_SOURCE_MIGRATION_RECEIPT_SCHEMA} is invalid`);
  }
  const fromDefinitionRevision = text(
    input.fromDefinitionRevision,
    "fromDefinitionRevision",
    128
  );
  const toDefinitionRevision = text(
    input.toDefinitionRevision,
    "toDefinitionRevision",
    128
  );
  const from = /^ScheduleRevision@1:([1-9][0-9]*)$/u.exec(fromDefinitionRevision);
  const to = /^ScheduleRevision@3:([1-9][0-9]*)$/u.exec(toDefinitionRevision);
  if (from === null || to === null || Number(to[1]) !== Number(from[1]) + 1) {
    throw new Error("migration definition revisions are inconsistent");
  }
  const workflowRef = text(input.workflowRef, "workflowRef", 256);
  if (!/^workflow:[a-z0-9][a-z0-9._/-]*@[1-9][0-9]*$/u.test(workflowRef)) {
    throw new Error("migration workflowRef must be a stable versioned workflow ref");
  }
  const receipt: ProactiveSourceMigrationReceipt = {
    schemaVersion: PROACTIVE_SOURCE_MIGRATION_RECEIPT_SCHEMA,
    receiptId: text(input.receiptId, "receiptId", 128),
    requestId: text(input.requestId, "requestId", 256),
    sourceKind: "schedule",
    sourceId: requireScheduleId(text(input.sourceId, "sourceId", 128)),
    fromDefinitionRevision,
    fromDefinitionDigest: sha256(input.fromDefinitionDigest, "fromDefinitionDigest"),
    toDefinitionRevision,
    targetDigest: sha256(input.targetDigest, "targetDigest"),
    workflowRef,
    registrationDigest: sha256(input.registrationDigest, "registrationDigest"),
    migratedAt: iso(input.migratedAt)
  };
  if (receipt.receiptId !== migrationReceiptId(receipt.requestId)) {
    throw new Error("migration receiptId does not match requestId");
  }
  return receipt;
}

function migrationReceiptId(requestId: string): string {
  return `psm1_${createHash("sha256").update(requestId).digest("base64url")}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableContractJson(value)).digest("hex")}`;
}

function sha256(value: unknown, field: string): string {
  const result = text(value, field, 71);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) {
    throw new Error(`${field} must be a sha256 digest`);
  }
  return result;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function iso(value: unknown): string {
  const input = text(value, "timestamp", 64);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds)) throw new Error("timestamp must be RFC 3339");
  return new Date(milliseconds).toISOString();
}
