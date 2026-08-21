import type { WorkspaceEffect } from "../../core/runtime/model.js";

export interface StewardDelegateTarget {
  readonly agentId: string;
  readonly handle: string;
  readonly client?: string;
}

export function stewardTurnPrompt(
  instruction: string,
  targets: readonly StewardDelegateTarget[],
  workspaceEffect?: WorkspaceEffect
): string {
  return [
    instruction,
    ...(workspaceEffect === "must_change"
      ? [
          "",
          "This Run requires an actual workspace change before outcome=succeeded.",
          "Runtime verifies the Git workspace revision independently; a claimed change is not evidence."
        ]
      : []),
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
      artifactRefs: [],
      outputs: [{
        id: "stable-output-id",
        title: "human-readable title",
        contentType: "application/json | text/markdown | text/plain",
        schemaVersion: "optional domain schema",
        value: "JSON value or text"
      }]
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

export function agentTurnAdjudicationPrompt(input: {
  readonly runId: string;
  readonly stepId: string;
  readonly originalAgentId: string;
  readonly contractError: string;
  readonly terminalEvidence: Readonly<Record<string, unknown>>;
  readonly workspaceEvidence?: Readonly<Record<string, unknown>>;
}): string {
  return [
    "You are the Steward performing the only recovery adjudication for one Agent Run turn.",
    "Do not call tools, inspect the workspace, modify state, or repeat the original work.",
    "Use only the bounded evidence below. Do not infer missing result fields or ignore conflicts.",
    "workspace.effect=must_change is a Runtime-owned completion gate. Never accept succeeded when workspace evidence says unchanged.",
    "Choose accept only when the evidence contains one unambiguous complete AgentTurnResult@1 that can be normalized without guessing.",
    "Choose retry only when safeToRetryEvidence proves both that the prior attempt has no unknown workspace or external side effects and that one retry can materially succeed.",
    "Otherwise choose needs_human. This adjudication is never retried or recursively adjudicated.",
    "",
    `Run: ${input.runId}`,
    `Step: ${input.stepId}`,
    `Original Agent: ${input.originalAgentId}`,
    `Contract/provider error: ${input.contractError}`,
    "Terminal evidence:",
    JSON.stringify(input.terminalEvidence, null, 2),
    ...(input.workspaceEvidence === undefined
      ? []
      : ["Workspace revision evidence:", JSON.stringify(input.workspaceEvidence, null, 2)]),
    "",
    "Return exactly one AgentTurnAdjudication@1 JSON object with no code fence or extra fields.",
    "For accept:",
    JSON.stringify({
      schemaVersion: "AgentTurnAdjudication@1",
      decision: "accept",
      rationale: "why normalization is evidence-backed",
      normalizedResult: {
        schemaVersion: "AgentTurnResult@1",
        action: "complete",
        outcome: "succeeded | failed | needs_human",
        summary: "bounded summary",
        artifactRefs: []
      }
    }, null, 2),
    "For retry:",
    JSON.stringify({
      schemaVersion: "AgentTurnAdjudication@1",
      decision: "retry",
      rationale: "why one retry can materially succeed",
      safeToRetryEvidence: ["specific bounded evidence proving retry safety"]
    }, null, 2),
    "For needs_human:",
    JSON.stringify({
      schemaVersion: "AgentTurnAdjudication@1",
      decision: "needs_human",
      rationale: "what remains unsafe or ambiguous"
    }, null, 2)
  ].join("\n");
}

export function agentTurnRetryPrompt(input: {
  readonly originalPrompt: string;
  readonly rationale: string;
  readonly safeToRetryEvidence: readonly string[];
}): string {
  return [
    "A single Steward adjudication authorized exactly one retry of this Agent Run turn.",
    "Do not treat this as permission for any further retry or scope expansion.",
    `Adjudication rationale: ${input.rationale}`,
    "Safe-to-retry evidence:",
    JSON.stringify(input.safeToRetryEvidence, null, 2),
    "",
    "Original turn prompt:",
    input.originalPrompt
  ].join("\n");
}

export function callerOrchestratedStepPrompt(
  instruction: string,
  workspaceEffect?: WorkspaceEffect
): string {
  return [
    instruction,
    ...(workspaceEffect === "must_change"
      ? [
          "",
          "This Run requires an actual workspace change before it can finish succeeded.",
          "Runtime verifies the Git workspace revision independently; report factual evidence only."
        ]
      : []),
    "",
    "Complete one bounded Worker step. The admitted Caller, not this Worker, owns the whole Run decision.",
    "Do not delegate and do not claim to terminalize the Run.",
    "Return exactly this JSON shape with no code fence or extra fields:",
    JSON.stringify({
      schemaVersion: "AgentStepResult@1",
      outcome: "succeeded | failed | needs_human",
      summary: "bounded factual step summary",
      artifactRefs: [],
      acceptanceEvidence: [],
      unresolvedQuestions: []
    }, null, 2)
  ].join("\n");
}

export function stewardOrchestratorPrompt(input: {
  readonly objective: string;
  readonly runVersion: number;
  readonly maxSteps: number;
  readonly completedWorkerSteps: number;
  readonly checkpoint?: unknown;
  readonly priorState?: unknown;
  readonly participants: readonly StewardDelegateTarget[];
  readonly taskUrl?: string;
  readonly workspaceEffect?: WorkspaceEffect;
}): string {
  const state = input.priorState ?? {
    schemaVersion: "OrchestratorState@1",
    goal: input.objective,
    tasks: [],
    acceptedEvidence: [],
    unresolvedQuestions: []
  };
  return [
    "You are the Steward Orchestrator for this Run. You own decomposition, Agent selection, handoff, and stopping; Workers do not.",
    input.checkpoint === undefined
      ? "First decompose the goal into a bounded task state, then select the first Worker. Keep stable taskIds; do not copy raw transcripts."
      : "Update the bounded task state from the newest Worker checkpoint. Keep stable taskIds and preserve accepted conclusions; do not copy raw transcripts.",
    "Choose next_step only when another bounded step can materially change completion. Use an exact admitted agentId. Finish only when the goal is actually satisfied; otherwise use needs_human when authority or information is missing.",
    "The next Worker receives only nextStep.mandate, not the checkpoint, prior task state, or decision history. Put every bounded fact and reference needed for the handoff into that mandate.",
    "The Runtime will validate this decision against the current Run version, roster, deadline, and budget. Never expand them.",
    ...(input.workspaceEffect === "must_change"
      ? ["Runtime will reject finish.outcome=succeeded until it independently observes a workspace revision change."]
      : []),
    "",
    `Goal: ${input.objective}`,
    `Current Run version: ${input.runVersion}`,
    `Worker step budget: ${input.completedWorkerSteps}/${input.maxSteps}`,
    ...(input.taskUrl === undefined ? [] : [`Result destination: ${input.taskUrl}`]),
    "",
    "Admitted participants:",
    JSON.stringify(input.participants, null, 2),
    "",
    "Prior OrchestratorState@1:",
    JSON.stringify(state, null, 2),
    "Every state.tasks item must use exactly this shape; assignedAgentId and summary are optional, and no other task fields are allowed:",
    JSON.stringify({
      taskId: "stable-task-id",
      objective: "bounded task objective",
      status: "pending | active | completed | blocked",
      assignedAgentId: "exact admitted agentId",
      summary: "optional bounded conclusion"
    }, null, 2),
    "",
    input.checkpoint === undefined
      ? "Current AgentRunCheckpoint@1: none; this is the initial decomposition decision."
      : "Current AgentRunCheckpoint@1:",
    ...(input.checkpoint === undefined
      ? []
      : [JSON.stringify(input.checkpoint, null, 2)]),
    "",
    "Return exactly one RunDecision@2 JSON object with no code fence or extra text.",
    "For next_step use:",
    JSON.stringify({
      schemaVersion: "RunDecision@2",
      action: "next_step",
      expectedRunVersion: input.runVersion,
      rationale: "why another bounded step is needed",
      checkedAcceptance: [],
      state,
      nextStep: {
        target: { kind: "agent", agentId: "exact admitted agentId" },
        mandate: { kind: "objective", objective: "bounded next objective" }
      }
    }, null, 2),
    "For terminal output replace action/nextStep with either finish={outcome,summary}, or action=needs_human with no finish/nextStep. Always include the updated state."
  ].join("\n");
}
