import { readFileSync, statSync } from "node:fs";

import { ScheduledTaskStore } from "../../capabilities/scheduled-task/store.js";
import { requireScheduleId } from "../../capabilities/scheduled-task/model.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { withImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
import { contractRecord, contractText, contractInteger, exactContractKeys } from "../../modules/steward/contract-codec.js";
import { loadOwnerExternalWorkflowRegistry } from "./external-workflow-registry.js";

/** Owner admission: immutable schedule ID, registry-owned authority, initially paused. */
export function registerExternalWorkflowSchedule(
  repoRoot: string, value: unknown, runtimeDirectory?: string, at = new Date().toISOString()
) {
  const input = contractRecord(value, "schedule registration");
  exactContractKeys(input, ["schemaVersion", "scheduleId", "ownerAgent", "workflowRef", "kind",
    "expression", "timezone", "misfirePolicy", "overlapPolicy", "misfireGraceMilliseconds"],
  "schedule registration", ["timezone"]);
  if (input.schemaVersion !== "ExternalWorkflowScheduleRegistration@1") {
    throw new Error("ExternalWorkflowScheduleRegistration@1 required");
  }
  if (input.kind !== "once" && input.kind !== "cron") throw new Error("kind must be once or cron");
  if (input.misfirePolicy !== "skip" && input.misfirePolicy !== "run_once") throw new Error("invalid misfirePolicy");
  if (input.overlapPolicy !== "skip" && input.overlapPolicy !== "queue") throw new Error("invalid overlapPolicy");
  const source = {
    scheduleId: requireScheduleId(contractText(input.scheduleId, "scheduleId", 256)),
    kind: input.kind,
    expression: contractText(input.expression, "expression", 256),
    ...(input.timezone === undefined ? {} : { timezone: contractText(input.timezone, "timezone", 128) }),
    misfirePolicy: input.misfirePolicy,
    overlapPolicy: input.overlapPolicy,
    misfireGraceMilliseconds: contractInteger(input.misfireGraceMilliseconds, "misfireGraceMilliseconds", 0, 604_800_000),
    target: loadOwnerExternalWorkflowRegistry(repoRoot, runtimeDirectory)
      .compileTarget(contractText(input.workflowRef, "workflowRef", 256))
  } as const;
  const database = openRuntimeDatabase(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const foundation = new LocalFoundationStore(database, { migrate: false });
    const schedules = new ScheduledTaskStore(database, { migrate: false });
    return withImmediateTransaction(database, () => {
      const owner = foundation.agentByHandle(contractText(input.ownerAgent, "ownerAgent", 128));
      if (owner === undefined || owner.status !== "active") throw new Error("Schedule owner must be an active Agent");
      const existing = schedules.get(source.scheduleId);
      if (existing !== undefined && existing.definition.ownerPrincipalId !== owner.principalId) {
        throw new Error("Schedule ID is already bound to another owner");
      }
      const schedule = schedules.createTargetedInTransaction({ ...source, ownerPrincipalId: owner.principalId }, at);
      return {
        status: existing === undefined ? "registered" : "duplicate",
        schedule: existing === undefined ? schedules.setStatus(source.scheduleId, "pause", at) : schedule
      };
    });
  } finally { database.close(); }
}

export function readScheduleRegistration(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 16_384) throw new Error("Schedule registration must be a JSON file up to 16384 bytes");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
