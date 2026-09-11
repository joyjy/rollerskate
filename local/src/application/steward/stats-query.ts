import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { readStewardStats } from "../../infrastructure/sqlite/steward-stats.js";

export function stewardStatsView(repoRoot: string, runtimeDirectory?: string, policyDigest?: string) {
  if (policyDigest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(policyDigest)) {
    throw new Error("steward-stats requires a sha256 policy digest");
  }
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const foundation = new LocalFoundationStore(database, { migrate: false });
    return { policyDigest: policyDigest ?? null,
      definitions: {
        successRate: "succeeded / (succeeded + failed + cancelled); pending and needs_human excluded",
        fallbackRate: "Runs with at least one rejected_manual_fallback receipt / all Runs",
        meanDurationMs: "Terminal Runs with finish receipt or cancellation timestamp only; includes queue time",
        cohort: "Immutable admitted policy digest; null means admitted without a policy"
      },
      groups: readStewardStats(database, policyDigest).map((group) => ({ ...group,
        handle: foundation.agent(group.agentId)?.handle ?? null })) };
  } finally { database.close(); }
}
