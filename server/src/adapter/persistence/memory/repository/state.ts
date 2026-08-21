import type {
  AgentCredentialRecord,
  AgentRecord,
  AgentRoomBindingRecord,
  AuthorizationTransactionRecord,
  BffSessionRecord,
  DeviceCredentialRecord,
  DeviceRecord,
  EnrollmentGrantRecord,
  HumanRecord,
  MatrixPrincipalRecord,
  PairingRecord,
  PlacementRecord,
  RoomMembershipRecord,
  RoomRecord,
  StoredRoomEventRecord
} from "../../../../application/model.js";

export class MemoryRepositoryState {
  readonly authorizationTransactions = new Map<string, AuthorizationTransactionRecord>();
  readonly allowlist = new Set<string>();
  readonly humans = new Map<string, HumanRecord>();
  readonly humanIdentity = new Map<string, string>();
  readonly sessions = new Map<string, BffSessionRecord>();
  readonly pairings = new Map<string, PairingRecord>();
  readonly devices = new Map<string, DeviceRecord>();
  readonly credentials = new Map<string, DeviceCredentialRecord>();
  readonly agents = new Map<string, AgentRecord>();
  readonly agentNames = new Map<string, string>();
  readonly placements = new Map<string, PlacementRecord>();
  readonly enrollments = new Map<string, EnrollmentGrantRecord>();
  readonly agentCredentials = new Map<string, AgentCredentialRecord>();
  readonly rooms = new Map<string, RoomRecord>();
  readonly roomMatrixIds = new Map<string, string>();
  readonly roomMemberships = new Map<string, RoomMembershipRecord>();
  readonly roomBindings = new Map<string, AgentRoomBindingRecord>();
  readonly roomEvents = new Map<string, StoredRoomEventRecord[]>();
  readonly matrixEvents = new Map<string, StoredRoomEventRecord>();
  readonly matrixPrincipals = new Map<string, MatrixPrincipalRecord>();
  readonly matrixMxids = new Map<string, string>();
  readonly matrixTransactions = new Set<string>();
}

export function identityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

export function agentNameKey(ownerHumanId: string, name: string): string {
  return `${ownerHumanId}\u0000${name}`;
}

export function membershipKey(roomId: string, humanId: string): string {
  return `${roomId}\u0000${humanId}`;
}

export function bindingKey(agentId: string, roomId: string): string {
  return `${agentId}\u0000${roomId}`;
}

export function principalKey(
  kind: MatrixPrincipalRecord["principalKind"],
  id: string
): string {
  return `${kind}\u0000${id}`;
}
