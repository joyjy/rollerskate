import type { DeviceAuthenticationRecord } from "../device/model.js";
import type {
  AgentAggregate,
  AgentAuthenticationRecord,
  AgentCredentialRecord,
  AgentRecord,
  AgentRoomBindingRecord,
  EnrollmentGrantRecord,
  PlacementRecord
} from "./model.js";

export interface CreateAgentInput {
  readonly device: DeviceAuthenticationRecord;
  readonly agent: AgentRecord;
  readonly placement: PlacementRecord;
  readonly enrollment: EnrollmentGrantRecord;
  readonly now: string;
}

export type CreateAgentFailure =
  | "verifier_mismatch"
  | "agent_not_active";

export type CreateAgentOutcome =
  | {
      readonly ok: true;
      readonly value: {
        readonly aggregate: AgentAggregate;
        readonly enrollment: EnrollmentGrantRecord;
      };
    }
  | { readonly ok: false; readonly reason: CreateAgentFailure };

export interface RedeemEnrollmentInput {
  readonly grantId: string;
  readonly deviceId: string;
  readonly verifierChallenge: string;
  readonly credential: AgentCredentialRecord;
  readonly now: string;
}

export type RedeemEnrollmentFailure =
  | "not_found"
  | "device_mismatch"
  | "verifier_mismatch"
  | "expired"
  | "revoked"
  | "placement_inactive"
  | "agent_inactive";

export type RedeemEnrollmentOutcome =
  | {
      readonly ok: true;
      readonly value: {
        readonly aggregate: AgentAggregate;
        readonly credential: AgentCredentialRecord;
      };
    }
  | { readonly ok: false; readonly reason: RedeemEnrollmentFailure };

export interface AgentRepository {
  createOrResumeAgent(input: CreateAgentInput): Promise<CreateAgentOutcome>;
  redeemEnrollment(input: RedeemEnrollmentInput): Promise<RedeemEnrollmentOutcome>;
  listAgentsForDevice(deviceId: string): Promise<readonly AgentAggregate[]>;
  getAgentForDeviceByName(
    deviceId: string,
    name: string
  ): Promise<AgentAggregate | undefined>;
  getAgentAuthentication(
    credentialId: string,
    now: string
  ): Promise<AgentAuthenticationRecord | undefined>;
  getAgentAggregateById(agentId: string): Promise<AgentAggregate | undefined>;
  rotateAgentCredential(
    agentId: string,
    placementId: string,
    credential: AgentCredentialRecord,
    now: string
  ): Promise<AgentCredentialRecord | undefined>;
  revokeAgentCredentials(agentId: string, now: string): Promise<number>;
  getAgentRoomBinding(
    agentId: string,
    roomId: string
  ): Promise<AgentRoomBindingRecord | undefined>;
  putAgentRoomBinding(binding: AgentRoomBindingRecord): Promise<AgentRoomBindingRecord>;
  updateAgentRoomBinding(binding: AgentRoomBindingRecord): Promise<void>;
  listAgentRoomBindings(
    agentId: string,
    activeOnly?: boolean
  ): Promise<readonly AgentRoomBindingRecord[]>;
}
