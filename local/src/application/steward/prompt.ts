import type { AcceptanceContract } from "../../modules/steward/acceptance.js";
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
    "Keep summary between 1 and 4096 characters. Keep each result array at no more than 100 non-empty strings, each no longer than 2048 characters.",
    "Do not copy large tool output into the result. Report exact bounded metadata and only the shortest excerpt needed as evidence.",
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
  readonly acceptanceOnly?: boolean;
  readonly objective: string;
  readonly runVersion: number;
  readonly maxSteps: number;
  readonly completedWorkerSteps: number;
  readonly workerAgentId?: string;
  readonly checkpoint?: unknown;
  readonly priorState?: unknown;
  readonly participants: readonly StewardDelegateTarget[];
  readonly taskUrl?: string;
  readonly workspaceEffect?: WorkspaceEffect;
  readonly contractVersion?: 2 | 3 | 4 | 5 | 6;
  readonly acceptanceContract?: AcceptanceContract;
  readonly currentNetworkAccess?: boolean;
  readonly triggerKinds?: readonly string[];
  readonly sourceEnvelope?: unknown;
}): string {
  const decisionVersion = input.contractVersion ?? 2;
  const exampleState = {
    schemaVersion: "OrchestratorState@1",
    goal: "concise business goal",
    tasks: [],
    acceptedEvidence: [],
    unresolvedQuestions: []
  };
  return [
    input.acceptanceOnly ? "You are the Steward accepting a completed fixed DAG. Only finish(scope=run), needs_human or ask_human are permitted. Evaluate the collected result against original acceptance; do not dispatch more work, change capabilities or bind sources." : "You are the Steward Orchestrator for this Run. You own decomposition, Agent selection, handoff, and stopping; Workers do not.",
    `Your response envelope is RunDecision@${decisionVersion}. The business request below defines the goal and deliverables, not a different response envelope.`,
    ...(decisionVersion >= 4 ? ["If the business request describes AgentTurnResult@1.outputs, map that outputs array to finish.outputs, preserving each output's id, contentType, schemaVersion and value. A requested report JSON belongs in an output's value. Do not return AgentTurnResult@1 or put outputs at the RunDecision top level."] : []),
    "",
    `Goal: ${input.objective}`,
    `Current Run version: ${input.runVersion}`,
    `Worker step budget: ${input.completedWorkerSteps}/${input.maxSteps}`,
    ...(input.workerAgentId === undefined ? [] : [
      `Owner-designated Worker: ${input.workerAgentId}. Every next_step must target this exact Agent. Do not substitute yourself or another participant.`,
      "Before success, obtain a checkpoint from the designated Worker for this Run/cycle. You own planning and final verification; send bounded execution to the Worker. Do not duplicate its full investigation."
    ]),
    ...(input.taskUrl === undefined ? [] : [`Result destination: ${input.taskUrl}`]),
    ...(input.triggerKinds === undefined
      ? []
      : [`Admitted trigger intents: ${input.triggerKinds.join(", ")}`]),
    "",
    input.checkpoint === undefined
      ? "First decompose the goal into a bounded task state, then select the first Worker. Keep stable taskIds; do not copy raw transcripts."
      : "Update the bounded task state from the newest Worker checkpoint. Keep stable taskIds and preserve accepted conclusions; do not copy raw transcripts.",
    ...(input.acceptanceOnly ? [] : ["Choose next_step only when another bounded step can materially change completion. Use an exact admitted agentId. Finish only when the goal is actually satisfied; otherwise use the human-input decision described below when blocked."]),
    ...(decisionVersion >= 3 && !input.acceptanceOnly
      ? [
          input.sourceEnvelope === undefined
            ? "Use await_source only to bind this standalone Run to one admitted trigger."
            : "This cycle came from the already-bound source in Current TriggerOccurrenceEnvelope@1. await_source is invalid now; use next_step, finish, or needs_human.",
          ...(input.triggerKinds?.some((kind) => kind === "once" || kind === "cron") === true
            ? [
                "Schedule templates are exact: schedule.once@1 uses {expression,misfirePolicy,overlapPolicy,misfireGraceMilliseconds,cancellationPolicy}; schedule.cron@1 adds timezone. Subscription templates are exact: subscription.until@1 uses {title,pluginRef,pluginConfig,intervalMilliseconds,maxWaitMilliseconds,maxAttempts,cancellationPolicy}; subscription.continuous@1 omits maxWaitMilliseconds/maxAttempts. pluginRef must come from admitted authority. cancellationPolicy is pause_source or cancel_source."
              ]
            : []),
          "finish must declare scope=cycle or scope=run. A source occurrence may finish its cycle and await the next occurrence, or close the whole Run."
        ]
      : []),
    ...(decisionVersion >= 4 ? ["finish.outputs may contain up to 20 generic outputs with unique URL-safe id, title, contentType (application/json, text/markdown, text/plain), optional schemaVersion, and value; the entire outputs array must fit within 32768 bytes. Return structured deliverables here; checkedAcceptance and state.acceptedEvidence are reasoning, not canonical outputs. Workers return AgentStepResult@1; pass report content through their bounded summary/artifactRefs and assemble final outputs yourself."] : []),
    ...(decisionVersion >= 5 ? [
      "When one concrete Owner answer can unblock this Run within its existing authority, choose action=ask_human with question (one concise question, at most 4096 characters), rationale, checkedAcceptance and state; omit nextStep, awaitSource and finish. This suspends the Run while preserving the checkpoint and accepted evidence. Use needs_human only when no safe continuation is known, including unknown external effects. An answer does not expand workspace, network, participants, budget or authority. Never use a question as a substitute for obtaining missing execution permission."
    ] : []),
    ...(input.acceptanceOnly ? [] : ["For every Worker handoff, put the bounded objective, necessary input facts and references, expected output, admitted workspace and acceptance check in the nextStep.mandate.objective text. For kind=objective, nextStep.mandate has exactly two fields: kind and objective; do not add inputFacts, references, expectedOutput, workspace or acceptance fields. Choose by the step's needs and actual admitted capability, never a permanent client-name role. Integrate and validate the returned evidence yourself; add a separate review step when the change or uncertainty warrants it.",
    "This Run schedules one Worker at a time. Keep edits inside the admitted workspace and do not launch untracked parallel writers. Preserve completed steps across callbacks; a Worker completion is evidence, not whole-task acceptance.",
    "The next Worker receives only nextStep.mandate, not the checkpoint, prior task state, or decision history. Put every bounded fact and reference needed for the handoff into that mandate."]),
    "The Runtime will validate this decision against the current Run version, roster, deadline, and budget. Never expand them.",
    ...(decisionVersion >= 6 ? [
      `Current effective network access: ${input.currentNetworkAccess === true ? "enabled" : "disabled"}. This overrides historical admission text in the objective.`,
      "Immutable original acceptance contract (higher priority than dispatch notes, task decomposition or worker claims):",
      JSON.stringify(input.acceptanceContract),
      "checkedAcceptance is an array of {id,status:pass|fail|unknown,evidenceRefs:string[]}. At success every original ID must occur exactly once, pass with evidence, and state.unresolvedQuestions must be empty. Missing or stale required evidence is unknown, never pass. A report listing gaps does not satisfy the underlying requirements.",
      ...(input.acceptanceOnly ? [] : ["Before work and again before finish, compare original acceptance with admitted capabilities. If network is needed but unavailable, return action=request_capability with capability={kind:network,acceptanceIds:[original IDs],targets:[exact URLs or hosts],reason:why needed}, plus expectedRunVersion,rationale,checkedAcceptance,state. Omit finish/nextStep/question. Runtime suspends and checks Owner authorization; a request grants nothing. Do not replace this with ask_human or reduce acceptance. Preserve useful evidence in state; after continuation do not repeat completed work."])
    ] : ["checkedAcceptance must be an array of plain strings."]),
    "state.acceptedEvidence and state.unresolvedQuestions are arrays of plain strings.",
    ...(input.workspaceEffect === "must_change"
      ? ["Runtime will reject finish.outcome=succeeded until it independently observes a workspace revision change."]
      : []),
    "",
    "Admitted participants:",
    JSON.stringify(input.participants, null, 2),
    "",
    "Prior OrchestratorState@1 (null means no accepted state yet):",
    JSON.stringify(input.priorState ?? null, null, 2),
    "Keep state.goal a concise description of the business goal; do not copy the full request, output schemas or transcripts into state. The full goal and original acceptance above remain authoritative.",
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
    ...(input.sourceEnvelope === undefined
      ? []
      : ["Current TriggerOccurrenceEnvelope@1:", JSON.stringify(input.sourceEnvelope, null, 2)]),
    "",
    `Return exactly one RunDecision@${decisionVersion} JSON object with no code fence or extra text.`,
    "The following examples show the response structure only. Replace example state with the updated task state, and fill checkedAcceptance from actual evidence. Produce complete valid JSON: escape quotes, backslashes and newlines inside strings; close every object and array. Keep rationale, state and report content concise rather than repeating the same evidence.",
    ...(input.acceptanceOnly ? [] : ["For next_step use:",
    JSON.stringify({
      schemaVersion: `RunDecision@${decisionVersion}`,
      action: "next_step",
      expectedRunVersion: input.runVersion,
      rationale: "why another bounded step is needed",
      checkedAcceptance: [],
      state: exampleState,
      nextStep: {
        target: { kind: "agent", agentId: "exact admitted agentId" },
        mandate: { kind: "objective", objective: "bounded next objective" }
      }
    }, null, 2)]),
    ...(decisionVersion >= 3
      ? [
          ...(input.sourceEnvelope === undefined && !input.acceptanceOnly
            ? [
                "For await_source use:",
                JSON.stringify({
                  schemaVersion: `RunDecision@${decisionVersion}`,
                  action: "await_source",
                  expectedRunVersion: input.runVersion,
                  rationale: "why the Run should wait for one admitted source",
                  checkedAcceptance: [],
                  state: exampleState,
                  awaitSource: {
                    sourceKind: "schedule | subscription | continuous_subscription",
                    templateId: "exact admitted template id",
                    parameters: {}
                  }
                }, null, 2)
              ]
            : []),
          "For finish use:",
          JSON.stringify({
            schemaVersion: `RunDecision@${decisionVersion}`,
            action: "finish",
            expectedRunVersion: input.runVersion,
            rationale: "why this scope is complete",
            checkedAcceptance: [],
            state: exampleState,
            finish: {
              scope: "run",
              outcome: "succeeded",
              summary: "bounded terminal summary",
              ...(decisionVersion >= 4 ? { outputs: [{
                id: "report",
                title: "Requested report",
                contentType: "application/json",
                value: { result: "replace with the requested deliverable" }
              }] } : {})
            }
          }, null, 2),
          "For needs_human omit nextStep/awaitSource/finish. Always include the updated state."
        ]
      : [
          "For terminal output replace action/nextStep with either finish={outcome,summary}, or action=needs_human with no finish/nextStep. Always include the updated state."
        ])
  ].join("\n");
}
