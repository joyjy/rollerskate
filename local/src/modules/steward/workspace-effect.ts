import type { AgentTurnResult } from "./result-contract.js";
import type { AgentRunWorkspaceGrant } from "./state-machine.js";

export function workspaceEffectFailure(
  grant: AgentRunWorkspaceGrant | undefined,
  result: AgentTurnResult,
  observedRevision: string | undefined
): string | undefined {
  if (grant?.effect !== "must_change" ||
    result.action !== "complete" ||
    result.outcome !== "succeeded") {
    return undefined;
  }
  if (observedRevision === undefined) {
    return "workspace.effect=must_change could not be verified by Runtime";
  }
  return observedRevision === grant.revision
    ? "workspace.effect=must_change requires a Runtime-observed revision change"
    : undefined;
}
