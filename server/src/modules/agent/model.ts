import type { AgentSummary, HumanSummary } from "@rollerskate/protocol";

import type { HumanRecord } from "../trust/model.js";

export interface AgentRecord {
  readonly id: string;
  readonly name: string;
  readonly ownerHumanId: string;
  readonly operatorHumanId: string;
  readonly status: "provisioning" | "active" | "suspended" | "revoked";
  readonly createdAt: string;
  readonly suspendedAt?: string;
}

export interface PlacementRecord {
  readonly id: string;
  readonly agentId: string;
  readonly deviceId: string;
  readonly state: "pending" | "active" | "superseded" | "revoked";
  readonly generation: number;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly supersededAt?: string;
}

export interface EnrollmentGrantRecord {
  readonly id: string;
  readonly agentId: string;
  readonly deviceId: string;
  readonly placementId: string;
  readonly credentialId: string;
  readonly verifierChallenge: string;
  readonly status: "issued" | "redeemed" | "expired" | "revoked";
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly redeemedAt?: string;
}

export interface AgentCredentialRecord {
  readonly id: string;
  readonly agentId: string;
  readonly placementId: string;
  readonly secretHash: string;
  readonly status: "active" | "revoked" | "expired";
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export interface AgentAggregate {
  readonly agent: AgentRecord;
  readonly placement: PlacementRecord;
  readonly owner: HumanRecord;
  readonly operator: HumanRecord;
  readonly credentialStatus: "pending" | "active" | "revoked" | "expired";
}

export interface AgentAuthenticationRecord extends AgentAggregate {
  readonly credential: AgentCredentialRecord;
}

export interface AgentRoomBindingRecord {
  readonly id: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly wakeMode: "disabled" | "mention_only" | "proactive";
  readonly createdByHumanId: string;
  readonly status: "active" | "inactive";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deactivatedAt?: string;
}

export function toAgentSummary(aggregate: AgentAggregate): AgentSummary {
  return {
    id: aggregate.agent.id,
    name: aggregate.agent.name,
    status: aggregate.agent.status,
    createdAt: aggregate.agent.createdAt,
    owner: humanSummary(aggregate.owner),
    operator: humanSummary(aggregate.operator),
    placement: {
      id: aggregate.placement.id,
      deviceId: aggregate.placement.deviceId,
      state: aggregate.placement.state,
      generation: aggregate.placement.generation,
      createdAt: aggregate.placement.createdAt,
      ...(aggregate.placement.activatedAt === undefined
        ? {}
        : { activatedAt: aggregate.placement.activatedAt })
    },
    credentialStatus: aggregate.credentialStatus
  };
}

function humanSummary(human: HumanRecord): HumanSummary {
  return {
    id: human.id,
    displayName: human.displayName,
    isAdmin: human.isAdmin
  };
}
