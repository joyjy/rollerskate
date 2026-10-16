import { forkWorkspace, type ForkWorkspaceInput } from "../workspace/control.js";
import { chatTaskSpan } from "./work-origin.js";
import { existingChatTask } from "./responsibility.js";
import type { ChatMessageEvent } from "../../core/event/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import type { LocalControlOptions } from "../agent/control.js";
import {
  startStewardRunFromAdmissionInTransaction,
  type StartStewardRunFromIntentReceipt
} from "../steward/intent-control.js";
import {
  projectChatRunProposal,
  type ChatRunWorkspaceSelection,
  type ChatRunProposalResolution,
  type ChatRunProposalView
} from "./run-proposal.js";

export interface ConfirmLocalChatRunProposalReceipt
  extends StartStewardRunFromIntentReceipt {
  readonly proposal: ChatRunProposalView;
}

export interface PreflightLocalChatRunProposalReceipt {
  readonly schema: "ChatRunProposalPreflight@1";
  readonly sourceRevision: string;
  readonly proposal: ChatRunProposalView;
}

export interface DeclineLocalChatRunProposalReceipt {
  readonly schema: "ChatRunProposalDecisionReceipt@1";
  readonly status: "declined" | "duplicate";
  readonly proposal: ChatRunProposalView;
}

export function declineLocalChatRunProposal(
  repoRoot: string,
  eventId: string,
  dispatchEventId: string,
  revision: string,
  options: LocalControlOptions = {}
): DeclineLocalChatRunProposalReceipt {
  if (revision.trim() === "") throw new Error("Run proposal revision is required");
  const database = openRuntimeDatabase(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  const runtime = new RuntimeStore(database);
  const foundation = new LocalFoundationStore(database, { migrate: false });
  try {
    return runtime.withImmediateTransaction(() => {
      const local = foundation.foundation();
      if (local === undefined) throw new Error("Local foundation is not initialized");
      const event = requireProposalSource(runtime, eventId, local.topicId);
      const projectionInput = {
        repoRoot,
        ...(options.runtimeDirectory === undefined
          ? {}
          : { runtimeDirectory: options.runtimeDirectory }),
        database,
        message: event,
        agents: foundation.listAgents(),
        dispatchEventId
      };
      const current = projectChatRunProposal(projectionInput);
      if (current === undefined) {
        throw new Error("Current Run proposal is not available for this message");
      }
      if (current.view.decision?.status === "declined") {
        return {
          schema: "ChatRunProposalDecisionReceipt@1",
          status: "duplicate",
          proposal: current.view
        };
      }
      if (current.view.linkedRun !== undefined) {
        throw new Error("Run proposal has already started and cannot be declined");
      }
      if (current.view.revision !== revision) {
        throw new Error("Run proposal revision is stale; refresh Chat before declining");
      }
      const recorded = runtime.recordChatRunProposalDeclinedInTransaction({
        sourceMessageEventId: event.eventId,
        dispatchEventId,
        actorPrincipalId: local.owner.principalId
      }, timestamp(options));
      const projected = projectChatRunProposal(projectionInput);
      if (projected?.view.decision?.status !== "declined") {
        throw new Error("Declined Run proposal did not project from its decision Event");
      }
      return {
        schema: "ChatRunProposalDecisionReceipt@1",
        status: recorded.status,
        proposal: projected.view
      };
    });
  } finally {
    foundation.close();
    runtime.close();
    database.close();
  }
}

export function preflightLocalChatRunProposal(
  repoRoot: string,
  eventId: string,
  dispatchEventId: string,
  revision: string,
  workspaceSelection: ChatRunWorkspaceSelection,
  options: LocalControlOptions = {},
  resolution?: ChatRunProposalResolution
): PreflightLocalChatRunProposalReceipt {
  if (revision.trim() === "") throw new Error("Run proposal revision is required");
  const database = openRuntimeDatabase(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  const runtime = new RuntimeStore(database);
  const foundation = new LocalFoundationStore(database, { migrate: false });
  try {
    const local = foundation.foundation();
    if (local === undefined) throw new Error("Local foundation is not initialized");
    const event = requireProposalSource(runtime, eventId, local.topicId);
    const projectionInput = {
      repoRoot,
      ...(options.runtimeDirectory === undefined
        ? {}
        : { runtimeDirectory: options.runtimeDirectory }),
      database,
      message: event,
      agents: foundation.listAgents()
    };
    const source = projectChatRunProposal({ ...projectionInput, dispatchEventId });
    if (source === undefined) {
      throw new Error("Current Run proposal is not available for this message");
    }
    if (source.view.decision?.status === "declined") {
      throw new Error("Run proposal has already been declined");
    }
    if (source.view.linkedRun !== undefined) {
      throw new Error("Run proposal has already started");
    }
    if (source.view.revision !== revision) {
      throw new Error("Run proposal revision is stale; refresh Chat before checking workspace");
    }
    const selected = projectChatRunProposal({
      ...projectionInput,
      dispatchEventId,
      workspaceSelection,
      ...(resolution === undefined ? {} : {resolution})
    });
    if (selected === undefined) {
      throw new Error("Current Run proposal is not available for this message");
    }
    return {
      schema: "ChatRunProposalPreflight@1",
      sourceRevision: source.view.revision,
      proposal: selected.view
    };
  } finally {
    foundation.close();
    runtime.close();
    database.close();
  }
}

export function confirmLocalChatRunProposal(
  repoRoot: string,
  eventId: string,
  dispatchEventId: string,
  revision: string,
  options: LocalControlOptions = {},
  workspaceSelection?: ChatRunWorkspaceSelection,
  resolution?: ChatRunProposalResolution
): ConfirmLocalChatRunProposalReceipt {
  if (revision.trim() === "") throw new Error("Run proposal revision is required");
  const database = openRuntimeDatabase(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  const runtime = new RuntimeStore(database);
  const foundation = new LocalFoundationStore(database, { migrate: false });
  try {
    return runtime.withImmediateTransaction(() => {
      const local = foundation.foundation();
      if (local === undefined) throw new Error("Local foundation is not initialized");
      const event = requireProposalSource(runtime, eventId, local.topicId);
      const projection = projectChatRunProposal({
        repoRoot,
        ...(options.runtimeDirectory === undefined
          ? {}
          : { runtimeDirectory: options.runtimeDirectory }),
        database,
        message: event,
        agents: foundation.listAgents(),
        dispatchEventId,
        ...(workspaceSelection === undefined ? {} : { workspaceSelection }),
        ...(resolution === undefined ? {} : {resolution})
      });
      if (projection === undefined) {
        throw new Error("Current Run proposal is not available for this message");
      }
      if (projection.view.decision?.status === "declined") {
        throw new Error("Run proposal has already been declined");
      }
      if (projection.view.revision !== revision) {
        throw new Error("Run proposal revision is stale; refresh Chat before confirming");
      }
      if (projection.admission === undefined ||
        (!projection.view.ready && projection.view.linkedRun === undefined)) {
        throw new Error(projection.view.blocker?.message ?? "Current Run proposal is blocked");
      }
      const taskSource = resolution?.taskSourceMessageEventId === undefined ? event
        : requireProposalSource(runtime, resolution.taskSourceMessageEventId, local.topicId);
      const existing = existingChatTask(database, taskSource.eventId, chatTaskSpan(taskSource.body, projection.view.finalForm.taskQuote));
      if (existing && existing.runId !== projection.view.linkedRun?.runId) {
        throw new Error(`This task already has responsible Run ${existing.runId}; continue that task`);
      }
      const started = startStewardRunFromAdmissionInTransaction(
        projection.admission,
        database,
        timestamp(options)
      );
      return { ...started, proposal: projection.view };
    });
  } finally {
    foundation.close();
    runtime.close();
    database.close();
  }
}

function requireProposalSource(
  runtime: RuntimeStore,
  eventId: string,
  topicId: string
): ChatMessageEvent {
  const event = runtime.event(eventId);
  if (event?.type !== "chat.message" || event.topicId !== topicId ||
    event.sender.kind !== "owner") {
    throw new Error("Run proposal source must be an exact Local Owner message");
  }
  return event;
}

function timestamp(options: LocalControlOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

export function forkLocalChatRunProposal(
  repoRoot: string, eventId: string, dispatchEventId: string, revision: string,
  input: ForkWorkspaceInput, options: LocalControlOptions = {}
) {
  // Reuse the exact active Owner proposal admission; Fork itself does not confirm a Run.
  preflightLocalChatRunProposal(repoRoot,eventId,dispatchEventId,revision,{kind:"path",path:input.path},options);
  return forkWorkspace(repoRoot,input,`proposal:${eventId}:${dispatchEventId}`,options.runtimeDirectory);
}
