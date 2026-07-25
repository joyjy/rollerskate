import {
  runtimeOperationsView,
  type RuntimeControlResultView
} from "./query.js";

export type { RuntimeControlResultView } from "./query.js";

/**
 * Compatibility name for the pre-v0.3.8 Console caller.
 * Runtime operation semantics are owned by runtimeOperationsView.
 */
export function runtimeConsoleView(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  consoleAddress: string,
  controlResult: RuntimeControlResultView | null = null
): unknown {
  return runtimeOperationsView(
    repoRoot,
    runtimeDirectory,
    consoleAddress,
    controlResult
  );
}
