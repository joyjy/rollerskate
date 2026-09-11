import { readFileSync, statSync } from "node:fs";
import { parseFileEventSource, assertFileRoot } from "../../capabilities/subscription/file-source.js";
import { ContinuousSubscriptionStore } from "../../capabilities/subscription/continuous-store.js";
import { contractRecord, exactContractKeys, contractText } from "../../modules/steward/contract-codec.js";
import { loadOwnerExternalWorkflowRegistry } from "../proactive/external-workflow-registry.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openInitializedRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { migrateLocalDatabase } from "../../infrastructure/sqlite/schema/index.js";
import { withImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
import { inspectContinuousSubscriptionView } from "./continuous.js";

/** Owner CLI admission only: source scope is explicit, executable authority comes from registry. */
export function registerFileSubscription(repoRoot: string, value: unknown, runtimeDirectory?: string) {
  const input = contractRecord(value, "file subscription registration");
  exactContractKeys(input, ["schemaVersion", "subscriptionId", "title", "source", "workflowRef"], "file subscription registration");
  if (input.schemaVersion !== "FileSubscriptionRegistration@1") throw new Error("FileSubscriptionRegistration@1 required");
  const source = parseFileEventSource(input.source);
  assertFileRoot(source);
  const target = loadOwnerExternalWorkflowRegistry(repoRoot, runtimeDirectory)
    .compileTarget(contractText(input.workflowRef, "workflowRef", 256));
  const subscriptionId = contractText(input.subscriptionId, "subscriptionId", 256);
  const database = openInitializedRuntimeDatabase(runtimePaths(repoRoot, runtimeDirectory).database, migrateLocalDatabase);
  try {
    const store = new ContinuousSubscriptionStore(database, { migrate: false });
    withImmediateTransaction(database, () => store.createFileInTransaction({
      schemaVersion: "ContinuousSubscriptionDefinition@4", revision: 1,
      subscriptionId, title: contractText(input.title, "title", 120), source, target
    }));
  } finally { database.close(); }
  return inspectContinuousSubscriptionView(repoRoot, subscriptionId, runtimeDirectory)!;
}

export function readFileSubscriptionRegistration(path: string): unknown {
  if (!statSync(path).isFile() || statSync(path).size > 16_384) throw new Error("file registration must be a JSON file up to 16384 bytes");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
