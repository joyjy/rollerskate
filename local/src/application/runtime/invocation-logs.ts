import { existsSync } from "node:fs";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { AgentInvocationLogMaintenance, type MaintenanceOptions } from "../../infrastructure/files/agent-invocation-log-maintenance.js";

export interface InvocationLogCommand {
  readonly action: "list" | "stats" | "read" | "payload" | "compress" | "cleanup";
  readonly path?: string;
  readonly runId?: string;
  readonly afterSequence?: number;
  readonly olderThanDays?: number;
  readonly applyRevision?: string;
}

/** File evidence is queried independently of schema migrations and Runtime startup. */
export function invocationLogs(repoRoot: string, runtimeDirectory: string | undefined, command: InvocationLogCommand): unknown {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const database = existsSync(paths.database) ? openRuntimeDatabaseReadOnly(paths.database) : undefined;
  try {
    const runs = database === undefined ? undefined : new AgentRunStore(database);
    const logs = new AgentInvocationLogMaintenance(paths.runtimeDirectory, {isRunTerminal(runId) {
      // needs_human is resumable. Restrict maintenance to explicitly archived final Runs.
      try {
        const run = runs?.projection(runId);
        return run === undefined ? undefined : run.archivedAt !== undefined &&
          ["succeeded", "failed", "cancelled"].includes(run.status);
      } catch { return undefined; }
    }});
    if (command.action === "payload") {
      if (!command.path) throw new Error("Invocation payload read requires an exact path");
      return {schemaVersion: "AgentInvocationPayloadRead@1", path: command.path, data: logs.readPayload(command.path)};
    }
    if (command.action === "read") {
      if (!command.path) throw new Error("Invocation log read requires an exact path");
      const records = logs.read(command.path);
      return {schemaVersion: "AgentInvocationLogRead@1", path: command.path,
        records: records.filter(value => command.afterSequence === undefined ||
          (typeof value === "object" && value !== null && "sequence" in value &&
            typeof value.sequence === "number" && value.sequence > command.afterSequence))};
    }
    if (command.action === "list" || command.action === "stats") {
      const inventory = logs.list();
      if (command.action === "list") return {schemaVersion: "AgentInvocationLogInventory@1", ...inventory,
        logs: command.runId === undefined ? inventory.logs : inventory.logs.filter(log => log.runId === command.runId)};
      return {schemaVersion: "AgentInvocationLogStats@1", totalBytes: inventory.totalBytes, complete: inventory.complete,
        logFiles: inventory.logs.length, compressedLogs: inventory.logs.filter(log => log.compressed).length,
        plainLogs: inventory.logs.filter(log => !log.compressed).length, protectedGroups: inventory.protectedGroups};
    }
    const options: MaintenanceOptions = {action: command.action,
      ...(command.olderThanDays === undefined ? {} : command.action === "compress"
        ? {compressAfterDays: command.olderThanDays, cleanupAfterDays: Math.max(30, command.olderThanDays)}
        : {cleanupAfterDays: command.olderThanDays, compressAfterDays: Math.min(7, command.olderThanDays)})};
    const preview = logs.preview(options);
    if (command.applyRevision === undefined) return {schemaVersion: "AgentInvocationLogMaintenancePreview@1", ...preview};
    if (preview.revision !== command.applyRevision) throw new Error("Invocation log preview changed; review a fresh preview");
    return {schemaVersion: "AgentInvocationLogMaintenanceResult@1", ...logs.apply(preview)};
  } finally { database?.close(); }
}
