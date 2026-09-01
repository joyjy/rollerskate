import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  readLegacyExecutionInventory,
  type LegacyExecutionInventory
} from "../../infrastructure/sqlite/legacy-trigger-inventory-query.js";

export function legacyExecutionInventory(
  repoRoot: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): LegacyExecutionInventory {
  return readLegacyExecutionInventory(runtimePaths(repoRoot, runtimeDirectory).database, at);
}
