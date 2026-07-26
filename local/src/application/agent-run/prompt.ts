export interface AgentRunDelegateTarget {
  readonly agentId: string;
  readonly handle: string;
}

export function agentRunTurnPrompt(
  instruction: string,
  targets: readonly AgentRunDelegateTarget[]
): string {
  return [
    instruction,
    "",
    "Active delegate targets for this turn:",
    JSON.stringify(targets, null, 2),
    targets.length === 0
      ? "No other active Agent is currently available; complete this step yourself."
      : "For action=delegate, targetAgentId must exactly match one agentId above.",
    "",
    "Return exactly one of these JSON shapes with no code fence or extra fields:",
    JSON.stringify({
      schemaVersion: "AgentTurnResult@1",
      action: "complete",
      outcome: "succeeded | failed | needs_human",
      summary: "bounded terminal summary",
      artifactRefs: []
    }, null, 2),
    "or",
    JSON.stringify({
      schemaVersion: "AgentTurnResult@1",
      action: "delegate",
      targetAgentId: "exact agentId from the roster",
      mandate: {
        kind: "objective",
        objective: "bounded child objective"
      },
      summary: "why this child is needed",
      artifactRefs: []
    }, null, 2)
  ].join("\n");
}
