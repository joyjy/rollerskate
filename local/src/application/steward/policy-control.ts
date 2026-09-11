import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { StewardPolicyStore } from "../../infrastructure/files/steward-policy-store.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { parseStewardPolicy, supportsStewardClient } from "../../modules/steward/steward-policy.js";

export function stewardPolicyView(repoRoot: string, runtimeDirectory?: string) {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  return { path: paths.stewardPolicy, policy: new StewardPolicyStore(paths.stewardPolicy).load() ?? null,
    default: "Unconfigured: active codex Agent receives all new Runs" };
}

export function configureStewardPolicy(repoRoot: string, value: unknown, runtimeDirectory?: string) {
  const policy = parseStewardPolicy(value);
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const database = openRuntimeDatabaseReadOnly(paths.database);
  try {
    const foundation = new LocalFoundationStore(database, { migrate: false });
    for (const entry of policy.entries) {
      const agent = foundation.agent(entry.agentId);
      if (agent?.status !== "active" || !supportsStewardClient(agent.client)) {
        throw new Error(`Steward policy requires an active supported Agent: ${entry.agentId}`);
      }
    }
    new StewardPolicyStore(paths.stewardPolicy).save(policy);
    return stewardPolicyView(repoRoot, runtimeDirectory);
  } finally { database.close(); }
}
