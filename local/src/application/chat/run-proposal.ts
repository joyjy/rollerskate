import { chatRunOriginSql, chatRunRequestId } from "./work-origin.js";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import type {
  ChatRunProposalDraft
} from "../../core/chat/model.js";
import {
  parseChatRunProposalDecision,
  type ChatMessageEvent
} from "../../core/event/model.js";
import { parseChatDecisionReceipt } from "../../core/runtime/store/codec.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import type {
  RunIntent,
  StewardRunRequest
} from "../../modules/steward/admission-contract.js";
import { inspectStewardWork, type StewardWorkView } from "../steward/work-query.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";
import { compileRunIntentInDatabase, StewardUnavailableError } from "../steward/admission.js";

export type ChatRunWorkspaceSelection =
  | { readonly kind: "project" }
  | { readonly kind: "local" }
  | { readonly kind: "path"; readonly path: string };

export interface ChatRunProposalBlocker {
  readonly code:
    | "workspace_required"
    | "workspace_invalid"
    | "clarification_required"
    | "steward_unavailable"
    | "admission_failed";
  readonly message: string;
  readonly action: "choose_workspace" | "reply" | "inspect_agents" | "inspect_runtime";
  readonly detail?: string;
}

export interface ChatRunProposalView {
  readonly schema: "ChatRunProposalView@2";
  readonly proposalId: string;
  readonly revision: string;
  readonly sourceMessageEventId: string;
  readonly sourceRootEventId: string;
  readonly dispatchEventId: string;
  readonly createdAt: string;
  readonly chatLead: {
    readonly agentId: string;
    readonly handle: string;
  };
  readonly finalForm: ChatRunProposalDraft;
  readonly ready: boolean;
  readonly blocker?: ChatRunProposalBlocker;
  readonly workspaceChoices?: readonly {
    readonly kind: ChatRunWorkspaceSelection["kind"];
    readonly label: string;
    readonly root?: string;
  }[];
  readonly selectedWorkspace?: {
    readonly kind: ChatRunWorkspaceSelection["kind"];
    readonly root: string;
  };
  readonly runOrchestrator?: {
    readonly agentId: string;
    readonly handle: string;
  };
  readonly participants: readonly {
    readonly agentId: string;
    readonly handle: string;
  }[];
  readonly authority?: {
    readonly summary: string;
    readonly workspace?: {
      readonly root: string;
      readonly revision: string;
      readonly access: "read" | "write";
      readonly effect?: "must_change" | "may_remain_unchanged";
      readonly networkAccess: boolean;
    };
    readonly maxSteps: number;
    readonly maxDepth: number;
  };
  readonly linkedRun?: StewardWorkView;
  readonly decision?: {
    readonly status: "declined";
    readonly eventId: string;
    readonly actorPrincipalId: string;
    readonly decidedAt: string;
  };
}

export interface ChatRunProposalProjection {
  readonly view: ChatRunProposalView;
  readonly admission?: StewardRunRequest;
}

export function projectChatRunProposal(input: {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  readonly database: DatabaseSync;
  readonly message: ChatMessageEvent;
  readonly agents: readonly LocalAgent[];
  readonly dispatchEventId?: string;
  readonly workspaceSelection?: ChatRunWorkspaceSelection;
}): ChatRunProposalProjection | undefined {
  const projections = projectChatRunProposals({ ...input, messages: [input.message] })
    .get(input.message.eventId) ?? [];
  return input.dispatchEventId === undefined
    ? projections[0]
    : projections.find(({ view }) => view.dispatchEventId === input.dispatchEventId);
}

interface ProposalDecisionRow {
  readonly event_id: string;
  readonly agent_id: string;
  readonly created_at: string;
  readonly payload_json: string;
  readonly receipt_json: string | null;
  readonly run_id: string | null;
  readonly owner_request_id: string | null;
  readonly proposal_decision_event_id: string | null;
  readonly proposal_decision_payload_json: string | null;
}

interface ProposalCandidate {
  readonly ownerRequestId?: string;
  readonly dispatchEventId: string;
  readonly agentId: string;
  readonly handle: string;
  readonly createdAt: string;
  readonly decisionCreatedAt: string;
  readonly proposal: ChatRunProposalDraft;
  readonly linkedRun?: ChatRunProposalView["linkedRun"];
  readonly decision?: ChatRunProposalView["decision"];
}

export function projectChatRunProposals(input: {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  readonly database: DatabaseSync;
  readonly messages: readonly ChatMessageEvent[];
  readonly agents: readonly LocalAgent[];
  readonly workspaceSelection?: ChatRunWorkspaceSelection;
}): ReadonlyMap<string, readonly ChatRunProposalProjection[]> {
  const messages = input.messages.filter((message) => message.sender.kind === "owner");
  if (messages.length === 0) return new Map();
  const workspaceRoots = proposalWorkspaceRoots(input);
  const rows = input.database.prepare(`
    SELECT event.event_id, event.agent_id, event.created_at, event.payload_json,
      execution.receipt_json,
      run.run_id, run.owner_request_id,
      proposal_decision.event_id AS proposal_decision_event_id,
      proposal_decision.payload_json AS proposal_decision_payload_json
    FROM events AS event
    JOIN executions AS execution ON execution.event_id = event.event_id
    LEFT JOIN agent_runs AS run
      ON ${chatRunOriginSql("event")}
    LEFT JOIN events AS proposal_decision
      ON proposal_decision.type = 'chat.message'
      AND proposal_decision.source_kind = 'cli'
      AND proposal_decision.source_external_id = 'chat-run-proposal-decision:' ||
        json_extract(event.payload_json, '$.sourceMessageEventId') || ':' || event.event_id
    WHERE event.type = 'chat.dispatch'
      AND json_extract(event.payload_json, '$.sourceMessageEventId') IN (
        ${messages.map(() => "?").join(", ")}
      )
    ORDER BY event.created_at, event.event_id
  `).all(...messages.map(({ eventId }) => eventId)) as unknown as ProposalDecisionRow[];
  const bySource = new Map<string, ProposalDecisionRow[]>();
  for (const row of rows) {
    const payload = parseDispatchPayload(row);
    const existing = bySource.get(payload.sourceMessageEventId) ?? [];
    existing.push(row);
    bySource.set(payload.sourceMessageEventId, existing);
  }
  const projections = new Map<string, readonly ChatRunProposalProjection[]>();
  for (const message of messages) {
    const dispatched = bySource.get(message.eventId) ?? [];
    if (dispatched.length === 0) continue;
    const candidates = dispatched.flatMap((row): readonly ProposalCandidate[] => {
      const decision = parseChatDecisionReceipt(row.receipt_json);
      if (decision?.proposal === undefined) return [];
      const payload = parseDispatchPayload(row);
      return [{
        ...(row.owner_request_id === null ? {} : { ownerRequestId: row.owner_request_id }),
        dispatchEventId: row.event_id,
        agentId: row.agent_id,
        handle: payload.targetHandleSnapshot,
        createdAt: row.created_at,
        decisionCreatedAt: decision.createdAt,
        proposal: decision.proposal,
        ...linkedRun(row, input),
        ...proposalDecision(row)
      }];
    }).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.dispatchEventId.localeCompare(right.dispatchEventId));
    if (candidates.length === 0) continue;
    projections.set(message.eventId, candidates.map((selected) =>
      projectSelectedProposal({ ...input, workspaceRoots }, message, selected)
    ));
  }
  return projections;
}

function projectSelectedProposal(
  input: {
    readonly repoRoot: string;
    readonly runtimeDirectory?: string;
    readonly database: DatabaseSync;
    readonly agents: readonly LocalAgent[];
    readonly workspaceSelection?: ChatRunWorkspaceSelection;
    readonly workspaceRoots: ProposalWorkspaceRoots;
  },
  message: ChatMessageEvent,
  selected: ProposalCandidate
): ChatRunProposalProjection {
  const participantIds = [selected.agentId];
  const terminal = selected.linkedRun !== undefined || selected.decision !== undefined;
  let admission: StewardRunRequest | undefined;
  let blocker = terminal ? undefined : proposalBlocker(selected.proposal.blockingQuestion);
  let workspaceRef: string | undefined;
  const requiresWorkspace = selected.proposal.desiredEffect === "read" ||
    selected.proposal.desiredEffect === "change";
  const workspaceSelection = requiresWorkspace ? input.workspaceSelection : undefined;
  if (blocker === undefined && requiresWorkspace) {
    if (workspaceSelection === undefined) {
      if (!terminal) {
        blocker = {
          code: "workspace_required",
          message: "Choose the exact Git workspace this Run may use.",
          action: "choose_workspace"
        };
      }
    } else {
      try {
        workspaceRef = workspaceRefForSelection(workspaceSelection);
      } catch (error) {
        blocker = admissionBlocker(error, true);
      }
    }
  }
  const shouldCompileAdmission = !terminal ||
    (selected.linkedRun !== undefined && (!requiresWorkspace || workspaceSelection !== undefined));
  if (blocker === undefined && shouldCompileAdmission) {
    try {
      admission = compileRunIntentInDatabase(
        input.repoRoot,
        runIntent(
          message,
          selected.dispatchEventId,
          selected.proposal,
          participantIds,
          workspaceRef,
          selected.ownerRequestId
        ),
        input.database,
        input.runtimeDirectory
      );
    } catch (error) {
      blocker = admissionBlocker(error, workspaceSelection !== undefined);
    }
  }
  if (terminal) blocker = undefined;
  const workspaceChoices = terminal
    ? undefined
    : proposalWorkspaceChoices(input.workspaceRoots, selected.proposal);
  const selectedWorkspace = terminal
    ? undefined
    : selectedWorkspaceView(workspaceSelection, admission?.authority.workspace?.root);
  const revision = digest({
    sourceMessageEventId: message.eventId,
    sourceRootEventId: message.causality.rootEventId,
    dispatchEventId: selected.dispatchEventId,
    proposal: selected.proposal,
    participantAgentIds: participantIds,
    workspaceSelection: workspaceSelection ?? null,
    blocker: blocker ?? null,
    admissionDigest: admission?.admissionDigest ?? null
  });
  const agentsById = new Map(input.agents.map((agent) => [agent.principalId, agent]));
  const orchestrator = input.agents.find((agent) =>
    agent.status === "active" && (admission?.stewardSelection === undefined
      ? agent.handle === "codex" : agent.principalId === admission.stewardSelection.agentId));
  const visibleParticipantIds = admission?.authority.participantAgentIds ?? [...new Set([
    ...(orchestrator === undefined ? [] : [orchestrator.principalId]),
    ...participantIds
  ])].sort();
  const participants = visibleParticipantIds.map((agentId) => ({
    agentId,
    handle: agentsById.get(agentId)?.handle ?? agentId
  }));
  return {
    view: {
      schema: "ChatRunProposalView@2",
      proposalId: `chat-proposal:${message.eventId}:${selected.dispatchEventId}`,
      revision,
      sourceMessageEventId: message.eventId,
      sourceRootEventId: message.causality.rootEventId,
      dispatchEventId: selected.dispatchEventId,
      createdAt: selected.decisionCreatedAt,
      chatLead: {
        agentId: selected.agentId,
        handle: selected.handle
      },
      finalForm: selected.proposal,
      ready: !terminal && blocker === undefined && admission !== undefined,
      ...(blocker === undefined ? {} : { blocker }),
      ...(workspaceChoices === undefined ? {} : { workspaceChoices }),
      ...(selectedWorkspace === undefined ? {} : { selectedWorkspace }),
      ...(orchestrator === undefined
        ? {}
        : {
            runOrchestrator: {
              agentId: orchestrator.principalId,
              handle: orchestrator.handle
            }
          }),
      participants,
      ...(admission === undefined
        ? {}
        : {
            authority: {
              summary: admission.authoritySummary,
              ...(admission.authority.workspace === undefined
                ? {}
                : { workspace: admission.authority.workspace }),
              maxSteps: admission.authority.maxSteps,
              maxDepth: admission.authority.maxDepth
            }
          }),
      ...(selected.linkedRun === undefined ? {} : { linkedRun: selected.linkedRun }),
      ...(selected.decision === undefined ? {} : { decision: selected.decision })
    },
    ...(admission === undefined ? {} : { admission })
  };
}

function proposalDecision(
  row: ProposalDecisionRow
): { readonly decision?: NonNullable<ChatRunProposalView["decision"]> } {
  if (row.proposal_decision_event_id === null ||
    row.proposal_decision_payload_json === null) return {};
  const payload = JSON.parse(row.proposal_decision_payload_json) as Record<string, unknown>;
  const decision = parseChatRunProposalDecision(
    payload.runProposalDecision,
    row.proposal_decision_event_id
  );
  if (decision === undefined) return {};
  return {
    decision: {
      status: "declined",
      eventId: row.proposal_decision_event_id,
      actorPrincipalId: decision.actor.principalId,
      decidedAt: decision.decidedAt
    }
  };
}

function linkedRun(
  row: ProposalDecisionRow,
  context: { readonly repoRoot: string; readonly runtimeDirectory?: string; readonly database: DatabaseSync }
): { readonly linkedRun?: StewardWorkView } {
  return row.run_id === null ? {} : {
    linkedRun: inspectStewardWork(context.repoRoot, row.run_id, context.runtimeDirectory, context.database)
  };
}

function parseDispatchPayload(row: ProposalDecisionRow): {
  readonly sourceMessageEventId: string;
  readonly targetHandleSnapshot: string;
} {
  const value = JSON.parse(row.payload_json) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    !("sourceMessageEventId" in value) ||
    typeof value.sourceMessageEventId !== "string" ||
    !("targetHandleSnapshot" in value) ||
    typeof value.targetHandleSnapshot !== "string") {
    throw new Error(`Chat proposal dispatch payload is malformed: ${row.event_id}`);
  }
  return {
    sourceMessageEventId: value.sourceMessageEventId,
    targetHandleSnapshot: value.targetHandleSnapshot
  };
}

function runIntent(
  message: ChatMessageEvent,
  dispatchEventId: string,
  proposal: ChatRunProposalDraft,
  participantIds: readonly string[],
  workspaceRef: string | undefined,
  existingRequestId?: string
): RunIntent {
  if (proposal.goal === undefined || proposal.scope.include.length === 0 ||
    proposal.acceptance.length === 0 || proposal.desiredEffect === undefined) {
    throw new Error("Run proposal is missing required final-form fields");
  }
  const goal = proposal.goal;
  return {
    schemaVersion: "RunIntent@1",
    requestId: existingRequestId ?? chatRunRequestId(message.eventId, dispatchEventId),
    objective: renderObjective(goal, proposal.scope),
    acceptance: proposal.acceptance,
    contextRefs: [
      `chat-topic:${message.topicId}`,
      `chat-message:${message.eventId}`,
      `chat-dispatch:${dispatchEventId}`
    ],
    ...(workspaceRef === undefined ? {} : { workspaceRef }),
    desiredEffect: proposal.desiredEffect,
    requestedParticipantRefs: participantIds.map((agentId) => `principal:${agentId}`),
    terminalEvidence: [
      "Record the terminal Run status and bounded result linked to the source Chat message"
    ]
  };
}

function renderObjective(
  goal: string,
  scope: ChatRunProposalDraft["scope"]
): string {
  return [
    "Goal:",
    goal,
    "",
    "Scope:",
    ...scope.include.map((item) => `- ${item}`),
    ...(scope.exclude.length === 0
      ? []
      : ["", "Out of scope:", ...scope.exclude.map((item) => `- ${item}`)])
  ].join("\n");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableContractJson(value)).digest("hex")}`;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1_000 ? message : `${message.slice(0, 999)}…`;
}

function proposalBlocker(question: string | undefined): ChatRunProposalBlocker | undefined {
  return question === undefined
    ? undefined
    : {
        code: "clarification_required",
        message: question,
        action: "reply"
      };
}

function admissionBlocker(
  error: unknown,
  workspaceSelected: boolean
): ChatRunProposalBlocker {
  const detail = boundedError(error);
  const normalizedDetail = detail.toLocaleLowerCase();
  if (error instanceof StewardUnavailableError) {
    return {
      code: "steward_unavailable",
      message: "The selected Steward Agent must be active before this Run can start.",
      action: "inspect_agents",
      detail
    };
  }
  if (workspaceSelected && (
    normalizedDetail.includes("workspace") ||
    normalizedDetail.includes("git rev-parse") ||
    normalizedDetail.includes("git repository") ||
    normalizedDetail.includes("enoent") ||
    normalizedDetail.includes("realpath")
  )) {
    return {
      code: "workspace_invalid",
      message: "The selected path is not an available Git workspace. Choose another workspace.",
      action: "choose_workspace",
      detail
    };
  }
  return {
    code: "admission_failed",
    message: "Run admission could not verify this proposal. Inspect the runtime and try again.",
    action: "inspect_runtime",
    detail
  };
}

function workspaceRefForSelection(selection: ChatRunWorkspaceSelection): string {
  if (selection.kind === "project") return "project:self";
  if (selection.kind === "local") return "local:workspace";
  const path = selection.path.trim();
  if (path === "") throw new Error("Custom workspace path is required");
  if (!isAbsolute(path)) throw new Error("Custom workspace path must be absolute");
  return pathToFileURL(path).href;
}

interface ProposalWorkspaceRoots {
  readonly project: string;
  readonly local?: string;
}

function proposalWorkspaceRoots(input: {
  readonly repoRoot: string;
  readonly database: DatabaseSync;
}): ProposalWorkspaceRoots {
  const foundation = new LocalFoundationStore(input.database, { migrate: false }).foundation();
  return {
    project: realpathSync(input.repoRoot),
    ...(foundation === undefined ? {} : { local: foundation.workspacePath })
  };
}

function proposalWorkspaceChoices(
  roots: ProposalWorkspaceRoots,
  proposal: ChatRunProposalDraft
): ChatRunProposalView["workspaceChoices"] {
  if (proposal.desiredEffect !== "read" && proposal.desiredEffect !== "change") {
    return undefined;
  }
  return [
    {
      kind: "project",
      label: "Rollerskate source",
      root: roots.project
    },
    ...(roots.local === undefined
      ? []
      : [{
          kind: "local" as const,
          label: "Local runtime workspace",
          root: roots.local
        }]),
    { kind: "path", label: "Other Git workspace" }
  ];
}

function selectedWorkspaceView(
  selection: ChatRunWorkspaceSelection | undefined,
  admittedRoot: string | undefined
): ChatRunProposalView["selectedWorkspace"] {
  if (selection === undefined) return undefined;
  if (admittedRoot !== undefined) return { kind: selection.kind, root: admittedRoot };
  if (selection.kind === "path") return { kind: selection.kind, root: selection.path.trim() };
  return undefined;
}
