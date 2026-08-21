import { bootstrapLocalFoundation, LocalFoundationStore } from
  "../../infrastructure/sqlite/foundation-store.js";
import {
  TopicGovernanceRevisionConflict,
  TopicGovernanceStore
} from
  "../../infrastructure/sqlite/topic-governance-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  transitionTopicGovernanceStatus,
  transitionTopicParticipant,
  type TopicGovernance,
  type TopicGovernanceControlAction,
  type TopicGovernanceControlReceipt,
  type TopicGovernanceMaterialization,
  type TopicGovernanceTransition
} from "../../modules/topic/governance.js";

export interface TopicGovernanceControlResult {
  readonly outcome: "applied" | "unchanged" | "conflict";
  readonly governance: TopicGovernance;
  readonly receipt?: TopicGovernanceControlReceipt;
}

export interface LocalTopicGovernanceControlOptions {
  readonly runtimeDirectory?: string;
  readonly now?: () => Date;
}

export function materializeLocalTopicGovernance(
  repoRoot: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): TopicGovernanceMaterialization {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const foundation = bootstrapLocalFoundation(paths, at);
  const foundationStore = new LocalFoundationStore(paths.database);
  const governanceStore = new TopicGovernanceStore(paths.database);
  try {
    const activeAgentIds = foundationStore.listAgents()
      .filter(({ status }) => status === "active")
      .map(({ principalId }) => principalId);
    return governanceStore.materializeDefault(foundation.topicId, activeAgentIds, at);
  } finally {
    governanceStore.close();
    foundationStore.close();
  }
}

export function pauseLocalTopic(
  repoRoot: string,
  expectedRevision: number,
  options: LocalTopicGovernanceControlOptions = {}
): TopicGovernanceControlResult {
  return mutateLocalTopicGovernance(
    repoRoot,
    expectedRevision,
    "pause",
    (current) => transitionTopicGovernanceStatus(current, "paused"),
    options
  );
}

export function resumeLocalTopic(
  repoRoot: string,
  expectedRevision: number,
  options: LocalTopicGovernanceControlOptions = {}
): TopicGovernanceControlResult {
  return mutateLocalTopicGovernance(
    repoRoot,
    expectedRevision,
    "resume",
    (current) => transitionTopicGovernanceStatus(current, "active"),
    options
  );
}

export function addLocalTopicParticipant(
  repoRoot: string,
  agentId: string,
  expectedRevision: number,
  options: LocalTopicGovernanceControlOptions = {}
): TopicGovernanceControlResult {
  return mutateLocalTopicParticipant(
    repoRoot, agentId, expectedRevision, "participant_add", "active", options
  );
}

export function removeLocalTopicParticipant(
  repoRoot: string,
  agentId: string,
  expectedRevision: number,
  options: LocalTopicGovernanceControlOptions = {}
): TopicGovernanceControlResult {
  return mutateLocalTopicParticipant(
    repoRoot, agentId, expectedRevision, "participant_remove", "removed", options
  );
}

function mutateLocalTopicParticipant(
  repoRoot: string,
  agentId: string,
  expectedRevision: number,
  action: "participant_add" | "participant_remove",
  status: "active" | "removed",
  options: LocalTopicGovernanceControlOptions
): TopicGovernanceControlResult {
  const foundationStore = new LocalFoundationStore(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  try {
    if (!foundationStore.listAgents().some(({ principalId }) => principalId === agentId)) {
      throw new Error(`Local Agent not found: ${agentId}`);
    }
  } finally {
    foundationStore.close();
  }
  return mutateLocalTopicGovernance(
    repoRoot,
    expectedRevision,
    action,
    (current, at) => transitionTopicParticipant(current, agentId, status, at),
    options
  );
}

function mutateLocalTopicGovernance(
  repoRoot: string,
  expectedRevision: number,
  action: Exclude<TopicGovernanceControlAction, "materialize_default">,
  transition: (current: TopicGovernance, at: string) => TopicGovernanceTransition | undefined,
  options: LocalTopicGovernanceControlOptions
): TopicGovernanceControlResult {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("expectedRevision must be a positive integer");
  }
  const at = timestamp(options);
  const materialized = materializeLocalTopicGovernance(repoRoot, options.runtimeDirectory, at);
  const topicId = materialized.governance.topicId;
  const store = new TopicGovernanceStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
  try {
    const current = store.require(topicId);
    const next = transition(current, at);
    if (next === undefined) return { outcome: "unchanged", governance: current };
    if (current.revision !== expectedRevision) {
      return { outcome: "conflict", governance: current };
    }
    try {
      const committed = store.commitRevision(topicId, {
        expectedRevision,
        action,
        actor: {
          kind: "owner",
          principalId: bootstrapLocalFoundation(
            runtimePaths(repoRoot, options.runtimeDirectory), at
          ).owner.principalId
        },
        changedFields: next.changedFields,
        next: next.next
      }, at);
      return { outcome: "applied", ...committed };
    } catch (error) {
      if (!(error instanceof TopicGovernanceRevisionConflict)) throw error;
      return {
        outcome: transition(error.current, at) === undefined ? "unchanged" : "conflict",
        governance: error.current
      };
    }
  } finally {
    store.close();
  }
}

function timestamp(options: LocalTopicGovernanceControlOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}
