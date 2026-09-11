import { ContinuousSubscriptionStore } from "../../capabilities/subscription/continuous-store.js";
import { ExternalWorkflowStore } from "../../infrastructure/proactive/external-workflow-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openInitializedRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema, migrateLocalDatabase } from "../../infrastructure/sqlite/schema/index.js";
import { withImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
import type { ExternalWorkflowRecoveryRequest } from "../../modules/proactive/recovery.js";
import { contractInteger, contractRecord, contractText, exactContractKeys } from "../../modules/steward/contract-codec.js";
import { loadOwnerExternalWorkflowRegistry } from "../proactive/external-workflow-registry.js";

/** Only the Owner CLI can confirm an unknown result or grant a single additional attempt. */
export function recoverFileSubscription(repoRoot: string, value: unknown, runtimeDirectory?: string) {
  const request = parseRequest(value);
  const database = openInitializedRuntimeDatabase(runtimePaths(repoRoot, runtimeDirectory).database, migrateLocalDatabase);
  try {
    const workflows = new ExternalWorkflowStore(database);
    const subscriptions = new ContinuousSubscriptionStore(database, { migrate: false, externalWorkflows: workflows });
    return withImmediateTransaction(database, () => {
      const duplicate = workflows.recoveryReceipt(request);
      if (duplicate !== undefined) return duplicate;
      const current = subscriptions.require(request.source.id);
      if (current.definition.schemaVersion !== "ContinuousSubscriptionDefinition@4" ||
        current.definition.target.kind !== "external_workflow" ||
        request.source.definitionRevision !== `${current.definition.schemaVersion}:${current.definition.revision}` ||
        current.status !== "blocked" || current.pendingOccurrenceKey === undefined) {
        throw new Error("file recovery requires the exact blocked file subscription revision and pending execution");
      }
      const execution = workflows.execution(request.source, current.pendingOccurrenceKey);
      if (execution === undefined || execution.executionId !== request.executionId) {
        throw new Error("file recovery pending execution conflict");
      }
      if (request.action === "retry") {
        // Recovery cannot silently upgrade command artifact/input/authority.
        loadOwnerExternalWorkflowRegistry(repoRoot, runtimeDirectory).resolve(execution.target);
      }
      const receipt = workflows.recoverInTransaction(request);
      subscriptions.applyFileRecoveryInTransaction(current.subscriptionId, execution.occurrenceKey, receipt.outcome, receipt.acceptedAt);
      return receipt;
    });
  } finally { database.close(); }
}

/** Bounded readback across all executions of this source, including preserved prior attempts. */
export function fileSubscriptionRecoveries(repoRoot: string, subscriptionId: string, runtimeDirectory?: string) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    assertCurrentLocalSchema(database);
    const subscriptions = new ContinuousSubscriptionStore(database, { migrate: false });
    if (subscriptions.require(subscriptionId).definition.schemaVersion !== "ContinuousSubscriptionDefinition@4") {
      throw new Error("file recovery history requires a file subscription");
    }
    return new ExternalWorkflowStore(database).recoveryReceipts({ kind: "continuous_subscription", id: subscriptionId });
  } finally { database.close(); }
}

function parseRequest(value: unknown): ExternalWorkflowRecoveryRequest {
  const input = contractRecord(value, "file subscription recovery");
  exactContractKeys(input, ["schemaVersion", "subscriptionId", "expectedDefinitionRevision", "executionId",
    "expectedAttemptCount", "requestId", "action", "reason", "retrySafe"], "file subscription recovery", ["retrySafe"]);
  if (input.schemaVersion !== "FileSubscriptionRecovery@1") throw new Error("FileSubscriptionRecovery@1 required");
  const action = input.action;
  if (action !== "retry" && action !== "resolve-succeeded" && action !== "resolve-failed") {
    throw new Error("file recovery action must be retry, resolve-succeeded or resolve-failed");
  }
  if (action === "retry" ? input.retrySafe !== true : input.retrySafe !== undefined) {
    throw new Error("retry requires retrySafe: true; result confirmation must omit retrySafe");
  }
  return {
    source: { kind: "continuous_subscription", id: contractText(input.subscriptionId, "subscriptionId", 256),
      definitionRevision: contractText(input.expectedDefinitionRevision, "expectedDefinitionRevision", 256) },
    executionId: contractText(input.executionId, "executionId", 256),
    expectedAttemptCount: contractInteger(input.expectedAttemptCount, "expectedAttemptCount", 0, 1_000_000),
    requestId: contractText(input.requestId, "requestId", 256), action,
    reason: contractText(input.reason, "reason", 4_096), ...(action === "retry" ? { retrySafe: true as const } : {})
  };
}
