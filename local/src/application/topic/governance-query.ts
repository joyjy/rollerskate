import type {
  TopicGovernance,
  TopicGovernanceControlReceipt
} from "../../modules/topic/governance.js";
import { TopicGovernanceStore } from
  "../../infrastructure/sqlite/topic-governance-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { materializeLocalTopicGovernance } from "./governance-control.js";
import { localRuntimeSnapshot } from "../agent/control.js";

export interface TopicGovernanceView {
  readonly governance: TopicGovernance;
  readonly activeParticipantAgentIds: readonly string[];
  readonly recentReceipts: readonly TopicGovernanceControlReceipt[];
  readonly actionAvailability: {
    readonly expectedRevision: number;
    readonly pause: boolean;
    readonly resume: boolean;
    readonly participantAddAgentIds: readonly string[];
    readonly participantRemoveAgentIds: readonly string[];
  };
}

export function inspectLocalTopicGovernance(
  repoRoot: string,
  runtimeDirectory?: string
): TopicGovernanceView {
  const materialized = materializeLocalTopicGovernance(repoRoot, runtimeDirectory);
  const store = new TopicGovernanceStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const activeParticipantAgentIds = materialized.governance.participants
      .filter(({ status }) => status === "active")
      .map(({ agentId }) => agentId);
    const activeParticipantSet = new Set(activeParticipantAgentIds);
    const agents = localRuntimeSnapshot(
      repoRoot,
      runtimeDirectory === undefined ? {} : { runtimeDirectory }
    ).agents;
    return {
      governance: materialized.governance,
      activeParticipantAgentIds,
      recentReceipts: store.receipts(materialized.governance.topicId),
      actionAvailability: {
        expectedRevision: materialized.governance.revision,
        pause: materialized.governance.status === "active",
        resume: materialized.governance.status === "paused",
        participantAddAgentIds: agents
          .filter(({ principalId }) => !activeParticipantSet.has(principalId))
          .map(({ principalId }) => principalId),
        participantRemoveAgentIds: activeParticipantAgentIds
      }
    };
  } finally {
    store.close();
  }
}
