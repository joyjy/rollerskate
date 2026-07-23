import { randomUUID } from "node:crypto";

import type {
  AgentAggregate,
  AgentAuthenticationRecord,
  AgentCredentialRecord,
  AgentRecord,
  AgentRoomBindingRecord,
  AppendedRoomEvent,
  AuthorizationTransactionRecord,
  BffSessionRecord,
  DeviceAuthenticationRecord,
  DeviceCredentialRecord,
  DeviceRecord,
  HumanRecord,
  MatrixPrincipalRecord,
  OidcIdentity,
  PairingRecord,
  PlacementRecord,
  RoomMembershipRecord,
  RoomRecord,
  StoredRoomEventRecord,
  EnrollmentGrantRecord,
  RedeemPairingInput
} from "../../../application/model.js";
import type {
  CreateAgentInput,
  CreateAgentOutcome,
  ServerRepository,
  PairingRedeemOutcome,
  RedeemEnrollmentInput,
  RedeemEnrollmentOutcome
} from "../../../application/repository.js";

export class MemoryRepository implements ServerRepository {
  readonly #authorizationTransactions = new Map<string, AuthorizationTransactionRecord>();
  readonly #allowlist = new Set<string>();
  readonly #humans = new Map<string, HumanRecord>();
  readonly #humanIdentity = new Map<string, string>();
  readonly #sessions = new Map<string, BffSessionRecord>();
  readonly #pairings = new Map<string, PairingRecord>();
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #credentials = new Map<string, DeviceCredentialRecord>();
  readonly #agents = new Map<string, AgentRecord>();
  readonly #agentNames = new Map<string, string>();
  readonly #placements = new Map<string, PlacementRecord>();
  readonly #enrollments = new Map<string, EnrollmentGrantRecord>();
  readonly #agentCredentials = new Map<string, AgentCredentialRecord>();
  readonly #rooms = new Map<string, RoomRecord>();
  readonly #roomMatrixIds = new Map<string, string>();
  readonly #roomMemberships = new Map<string, RoomMembershipRecord>();
  readonly #roomBindings = new Map<string, AgentRoomBindingRecord>();
  readonly #roomEvents = new Map<string, StoredRoomEventRecord[]>();
  readonly #matrixEvents = new Map<string, StoredRoomEventRecord>();
  readonly #matrixPrincipals = new Map<string, MatrixPrincipalRecord>();
  readonly #matrixMxids = new Map<string, string>();
  readonly #matrixTransactions = new Set<string>();

  public async putAuthorizationTransaction(
    record: AuthorizationTransactionRecord
  ): Promise<void> {
    this.#authorizationTransactions.set(record.state, record);
  }

  public async takeAuthorizationTransaction(
    state: string,
    now: string
  ): Promise<AuthorizationTransactionRecord | undefined> {
    const record = this.#authorizationTransactions.get(state);
    if (
      record === undefined ||
      record.consumedAt !== undefined ||
      Date.parse(record.expiresAt) <= Date.parse(now)
    ) {
      return undefined;
    }
    this.#authorizationTransactions.set(state, { ...record, consumedAt: now });
    return record;
  }

  public async admitHuman(
    identity: OidcIdentity,
    now: string
  ): Promise<HumanRecord | undefined> {
    const key = identityKey(identity.issuer, identity.subject);
    const existingId = this.#humanIdentity.get(key);
    const existing = existingId === undefined ? undefined : this.#humans.get(existingId);
    const isBootstrapAdmin = this.#humans.size === 0;
    if (
      !isBootstrapAdmin &&
      existing?.isAdmin !== true &&
      !this.#allowlist.has(key)
    ) {
      return undefined;
    }
    const human: HumanRecord = {
      id: existing?.id ?? randomUUID(),
      issuer: identity.issuer,
      subject: identity.subject,
      displayName: identity.displayName,
      status: existing?.status ?? "active",
      isAdmin: existing?.isAdmin === true || isBootstrapAdmin,
      metadata: identity.metadata,
      createdAt: existing?.createdAt ?? now
    };
    this.#humans.set(human.id, human);
    this.#humanIdentity.set(key, human.id);
    return human;
  }

  public async allowSubject(
    issuer: string,
    subject: string,
    _createdByHumanId: string,
    _now: string
  ): Promise<void> {
    this.#allowlist.add(identityKey(issuer, subject));
  }

  public async getHuman(id: string): Promise<HumanRecord | undefined> {
    return this.#humans.get(id);
  }

  public async putSession(record: BffSessionRecord): Promise<void> {
    this.#sessions.set(record.id, record);
  }

  public async getSession(
    id: string,
    now: string
  ): Promise<BffSessionRecord | undefined> {
    const record = this.#sessions.get(id);
    return record !== undefined &&
      record.revokedAt === undefined &&
      Date.parse(record.expiresAt) > Date.parse(now)
      ? record
      : undefined;
  }

  public async putPairing(record: PairingRecord): Promise<void> {
    if (this.#pairings.has(record.id)) {
      throw new Error(`pairing already exists: ${record.id}`);
    }
    this.#pairings.set(record.id, record);
  }

  public async getPairing(id: string, now: string): Promise<PairingRecord | undefined> {
    const record = this.#pairings.get(id);
    if (record === undefined) {
      return undefined;
    }
    if (
      (record.status === "pending" || record.status === "approved") &&
      Date.parse(record.expiresAt) <= Date.parse(now)
    ) {
      const expired: PairingRecord = { ...record, status: "expired" };
      this.#pairings.set(id, expired);
      return expired;
    }
    return record;
  }

  public async claimPairingAuthorizationPoll(
    id: string,
    now: string
  ): Promise<PairingRecord | undefined> {
    const record = await this.getPairing(id, now);
    if (
      record === undefined ||
      record.status !== "pending" ||
      record.oidcDeviceCode === undefined ||
      record.pollIntervalMilliseconds === undefined ||
      (record.lastPolledAt !== undefined &&
        Date.parse(record.lastPolledAt) + record.pollIntervalMilliseconds > Date.parse(now))
    ) {
      return undefined;
    }
    const claimed = { ...record, lastPolledAt: now };
    this.#pairings.set(id, claimed);
    return claimed;
  }

  public async updatePairingPollInterval(
    id: string,
    milliseconds: number
  ): Promise<void> {
    const record = this.#pairings.get(id);
    if (record?.status === "pending") {
      this.#pairings.set(id, { ...record, pollIntervalMilliseconds: milliseconds });
    }
  }

  public async finishPairingAuthorization(
    id: string,
    status: "expired" | "cancelled"
  ): Promise<void> {
    const record = this.#pairings.get(id);
    if (record?.status === "pending") {
      this.#pairings.set(id, { ...record, status });
    }
  }

  public async approvePairing(
    id: string,
    humanId: string,
    now: string
  ): Promise<boolean> {
    const record = await this.getPairing(id, now);
    if (record === undefined || record.status !== "pending") {
      return false;
    }
    this.#pairings.set(id, {
      ...record,
      status: "approved",
      approvedHumanId: humanId
    });
    return true;
  }

  public async redeemPairing(input: RedeemPairingInput): Promise<PairingRedeemOutcome> {
    const record = await this.getPairing(input.pairingId, input.now);
    if (record === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (record.status === "expired") {
      return { ok: false, reason: "expired" };
    }
    if (record.status === "redeemed") {
      return { ok: false, reason: "already_redeemed" };
    }
    if (record.status !== "approved" || record.approvedHumanId === undefined) {
      return { ok: false, reason: "not_approved" };
    }
    if (record.deviceId !== input.deviceId) {
      return { ok: false, reason: "device_mismatch" };
    }
    if (record.verifierChallenge !== input.verifierChallenge) {
      return { ok: false, reason: "verifier_mismatch" };
    }
    if (this.#devices.has(input.deviceId)) {
      return { ok: false, reason: "device_exists" };
    }
    const human = this.#humans.get(record.approvedHumanId);
    if (human === undefined) {
      throw new Error(`approved Human is missing: ${record.approvedHumanId}`);
    }
    const device: DeviceRecord = {
      id: record.deviceId,
      humanId: human.id,
      name: record.deviceName,
      status: "active",
      createdAt: input.now
    };
    this.#devices.set(device.id, device);
    this.#credentials.set(input.credential.id, input.credential);
    this.#pairings.set(record.id, {
      ...record,
      status: "redeemed",
      redeemedAt: input.now
    });
    return {
      ok: true,
      value: { device, human, credential: input.credential }
    };
  }

  public async getDeviceAuthentication(
    credentialId: string,
    now: string
  ): Promise<DeviceAuthenticationRecord | undefined> {
    const credential = this.#credentials.get(credentialId);
    if (
      credential === undefined ||
      credential.status !== "active" ||
      credential.revokedAt !== undefined ||
      (credential.expiresAt !== undefined &&
        Date.parse(credential.expiresAt) <= Date.parse(now))
    ) {
      return undefined;
    }
    const device = this.#devices.get(credential.deviceId);
    const human = device === undefined ? undefined : this.#humans.get(device.humanId);
    return device?.status === "active" && human?.status === "active"
      ? { credential, device, human }
      : undefined;
  }

  public async revokeDeviceCredential(
    credentialId: string,
    now: string
  ): Promise<boolean> {
    const credential = this.#credentials.get(credentialId);
    if (credential === undefined || credential.status !== "active") {
      return false;
    }
    this.#credentials.set(credential.id, {
      ...credential,
      status: "revoked",
      revokedAt: now
    });
    const device = this.#devices.get(credential.deviceId);
    if (device !== undefined) {
      this.#devices.set(device.id, {
        ...device,
        status: "revoked",
        revokedAt: now
      });
    }
    return true;
  }

  public async createOrResumeAgent(
    input: CreateAgentInput
  ): Promise<CreateAgentOutcome> {
    const existingId = this.#agentNames.get(input.agent.name);
    if (existingId === undefined) {
      this.#agents.set(input.agent.id, input.agent);
      this.#agentNames.set(input.agent.name, input.agent.id);
      this.#placements.set(input.placement.id, input.placement);
      this.#enrollments.set(input.enrollment.id, input.enrollment);
      return {
        ok: true,
        value: {
          aggregate: this.#aggregate(input.agent, input.placement),
          enrollment: input.enrollment
        }
      };
    }
    const agent = this.#agents.get(existingId);
    if (agent === undefined) {
      throw new Error(`Agent name index is corrupt: ${input.agent.name}`);
    }
    if (agent.ownerHumanId !== input.device.human.id) {
      return { ok: false, reason: "name_taken" };
    }
    if (agent.status !== "provisioning" && agent.status !== "active") {
      return { ok: false, reason: "agent_not_active" };
    }
    const placement = [...this.#placements.values()].find(
      (candidate) => candidate.agentId === agent.id &&
        (candidate.state === "pending" || candidate.state === "active")
    );
    if (placement === undefined || placement.deviceId !== input.device.device.id) {
      return { ok: false, reason: "different_device" };
    }
    const enrollment = [...this.#enrollments.values()].find(
      (candidate) => candidate.agentId === agent.id &&
        candidate.placementId === placement.id
    );
    if (enrollment === undefined) {
      throw new Error(`Agent enrollment is missing: ${agent.id}`);
    }
    if (enrollment.verifierChallenge !== input.enrollment.verifierChallenge) {
      return { ok: false, reason: "verifier_mismatch" };
    }
    if (enrollment.status === "revoked") {
      return { ok: false, reason: "agent_not_active" };
    }
    const resumed = enrollment.status === "expired" ||
      (enrollment.status === "issued" &&
        Date.parse(enrollment.expiresAt) <= Date.parse(input.now))
      ? { ...enrollment, status: "issued" as const, expiresAt: input.enrollment.expiresAt }
      : enrollment;
    this.#enrollments.set(resumed.id, resumed);
    return {
      ok: true,
      value: {
        aggregate: this.#aggregate(agent, placement),
        enrollment: resumed
      }
    };
  }

  public async redeemEnrollment(
    input: RedeemEnrollmentInput
  ): Promise<RedeemEnrollmentOutcome> {
    const enrollment = this.#enrollments.get(input.grantId);
    if (enrollment === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (enrollment.deviceId !== input.deviceId) {
      return { ok: false, reason: "device_mismatch" };
    }
    if (enrollment.verifierChallenge !== input.verifierChallenge) {
      return { ok: false, reason: "verifier_mismatch" };
    }
    if (enrollment.status === "revoked") {
      return { ok: false, reason: "revoked" };
    }
    if (
      enrollment.status === "issued" &&
      Date.parse(enrollment.expiresAt) <= Date.parse(input.now)
    ) {
      this.#enrollments.set(enrollment.id, { ...enrollment, status: "expired" });
      return { ok: false, reason: "expired" };
    }
    const agent = this.#agents.get(enrollment.agentId);
    const placement = this.#placements.get(enrollment.placementId);
    if (agent === undefined || (agent.status !== "provisioning" && agent.status !== "active")) {
      return { ok: false, reason: "agent_inactive" };
    }
    if (
      placement === undefined ||
      (placement.state !== "pending" && placement.state !== "active")
    ) {
      return { ok: false, reason: "placement_inactive" };
    }
    if (enrollment.status === "redeemed") {
      const credential = this.#agentCredentials.get(enrollment.credentialId);
      if (credential === undefined) {
        throw new Error(`Redeemed Agent credential is missing: ${enrollment.credentialId}`);
      }
      return {
        ok: true,
        value: { aggregate: this.#aggregate(agent, placement), credential }
      };
    }
    const activeAgent: AgentRecord = { ...agent, status: "active" };
    const activePlacement: PlacementRecord = {
      ...placement,
      state: "active",
      activatedAt: input.now
    };
    const redeemed: EnrollmentGrantRecord = {
      ...enrollment,
      status: "redeemed",
      redeemedAt: input.now
    };
    const credential: AgentCredentialRecord = {
      ...input.credential,
      id: enrollment.credentialId,
      agentId: enrollment.agentId,
      placementId: enrollment.placementId
    };
    this.#agents.set(activeAgent.id, activeAgent);
    this.#placements.set(activePlacement.id, activePlacement);
    this.#enrollments.set(redeemed.id, redeemed);
    this.#agentCredentials.set(credential.id, credential);
    return {
      ok: true,
      value: {
        aggregate: this.#aggregate(activeAgent, activePlacement),
        credential
      }
    };
  }

  public async listAgentsForDevice(deviceId: string): Promise<readonly AgentAggregate[]> {
    return [...this.#placements.values()]
      .filter((placement) => placement.deviceId === deviceId &&
        (placement.state === "pending" || placement.state === "active"))
      .map((placement) => {
        const agent = this.#agents.get(placement.agentId);
        if (agent === undefined) {
          throw new Error(`Placement Agent is missing: ${placement.agentId}`);
        }
        return this.#aggregate(agent, placement);
      })
      .sort((left, right) => left.agent.name.localeCompare(right.agent.name));
  }

  public async getAgentForDeviceByName(
    deviceId: string,
    name: string
  ): Promise<AgentAggregate | undefined> {
    return (await this.listAgentsForDevice(deviceId)).find(
      (aggregate) => aggregate.agent.name === name
    );
  }

  public async getAgentAuthentication(
    credentialId: string,
    now: string
  ): Promise<AgentAuthenticationRecord | undefined> {
    const credential = this.#agentCredentials.get(credentialId);
    if (
      credential === undefined ||
      credential.status !== "active" ||
      credential.revokedAt !== undefined ||
      (credential.expiresAt !== undefined &&
        Date.parse(credential.expiresAt) <= Date.parse(now))
    ) {
      return undefined;
    }
    const agent = this.#agents.get(credential.agentId);
    const placement = this.#placements.get(credential.placementId);
    if (
      agent === undefined || agent.status !== "active" ||
      placement === undefined || placement.state !== "active" ||
      placement.agentId !== agent.id
    ) {
      return undefined;
    }
    return {
      ...this.#aggregate(agent, placement),
      credential
    };
  }

  public async getAgentAggregateById(agentId: string): Promise<AgentAggregate | undefined> {
    const agent = this.#agents.get(agentId);
    if (agent === undefined) {
      return undefined;
    }
    const placement = [...this.#placements.values()].find(
      (candidate) => candidate.agentId === agentId &&
        (candidate.state === "pending" || candidate.state === "active")
    );
    return placement === undefined ? undefined : this.#aggregate(agent, placement);
  }

  public async createRoom(
    room: RoomRecord,
    creator: RoomMembershipRecord
  ): Promise<void> {
    if (this.#rooms.has(room.id) || this.#roomMatrixIds.has(room.matrixRoomId)) {
      throw new Error(`Room already exists: ${room.id}`);
    }
    this.#rooms.set(room.id, room);
    this.#roomMatrixIds.set(room.matrixRoomId, room.id);
    this.#roomMemberships.set(membershipKey(room.id, creator.humanId), creator);
  }

  public async getRoom(roomId: string): Promise<RoomRecord | undefined> {
    return this.#rooms.get(roomId);
  }

  public async getRoomByMatrixId(matrixRoomId: string): Promise<RoomRecord | undefined> {
    const id = this.#roomMatrixIds.get(matrixRoomId);
    return id === undefined ? undefined : this.#rooms.get(id);
  }

  public async listRoomsForHuman(humanId: string): Promise<readonly {
    readonly room: RoomRecord;
    readonly membership?: RoomMembershipRecord;
  }[]> {
    return [...this.#rooms.values()]
      .filter((room) => {
        const membership = this.#roomMemberships.get(membershipKey(room.id, humanId));
        return room.visibility === "public" ||
          (membership !== undefined && membership.status !== "left");
      })
      .map((room) => {
        const membership = this.#roomMemberships.get(membershipKey(room.id, humanId));
        return { room, ...(membership === undefined ? {} : { membership }) };
      })
      .sort((left, right) => left.room.name.localeCompare(right.room.name));
  }

  public async getRoomMembership(
    roomId: string,
    humanId: string
  ): Promise<RoomMembershipRecord | undefined> {
    return this.#roomMemberships.get(membershipKey(roomId, humanId));
  }

  public async putRoomMembership(membership: RoomMembershipRecord): Promise<void> {
    this.#roomMemberships.set(membershipKey(membership.roomId, membership.humanId), membership);
  }

  public async getAgentRoomBinding(
    agentId: string,
    roomId: string
  ): Promise<AgentRoomBindingRecord | undefined> {
    return this.#roomBindings.get(bindingKey(agentId, roomId));
  }

  public async putAgentRoomBinding(
    binding: AgentRoomBindingRecord
  ): Promise<AgentRoomBindingRecord> {
    const key = bindingKey(binding.agentId, binding.roomId);
    const existing = this.#roomBindings.get(key);
    if (existing !== undefined && existing.status === "active") {
      return existing;
    }
    this.#roomBindings.set(key, binding);
    return binding;
  }

  public async updateAgentRoomBinding(binding: AgentRoomBindingRecord): Promise<void> {
    const key = bindingKey(binding.agentId, binding.roomId);
    if (!this.#roomBindings.has(key)) {
      throw new Error(`Agent Room binding is missing: ${binding.agentId}/${binding.roomId}`);
    }
    this.#roomBindings.set(key, binding);
  }

  public async listAgentRoomBindings(
    agentId: string,
    activeOnly = false
  ): Promise<readonly AgentRoomBindingRecord[]> {
    return [...this.#roomBindings.values()]
      .filter((binding) => binding.agentId === agentId &&
        (!activeOnly || binding.status === "active"))
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
  }

  public async appendRoomEvent(input: {
    readonly roomId: string;
    readonly matrixEventId: string;
    readonly event: StoredRoomEventRecord["event"];
    readonly retainedUntil?: string;
  }): Promise<AppendedRoomEvent> {
    const existing = this.#matrixEvents.get(input.matrixEventId);
    if (existing !== undefined) {
      return { created: false, record: existing, candidateBindings: [] };
    }
    const room = this.#rooms.get(input.roomId);
    if (room === undefined) {
      throw new Error(`Room is missing: ${input.roomId}`);
    }
    const record: StoredRoomEventRecord = {
      roomId: room.id,
      sequence: room.headSequence + 1,
      matrixEventId: input.matrixEventId,
      event: input.event,
      ...(input.retainedUntil === undefined ? {} : { retainedUntil: input.retainedUntil })
    };
    this.#rooms.set(room.id, { ...room, headSequence: record.sequence });
    const events = this.#roomEvents.get(room.id) ?? [];
    events.push(record);
    this.#roomEvents.set(room.id, events);
    this.#matrixEvents.set(input.matrixEventId, record);
    return {
      created: true,
      record,
      candidateBindings: [...this.#roomBindings.values()].filter(
        (binding) => binding.roomId === room.id && binding.status === "active"
      )
    };
  }

  public async listRoomEvents(
    roomId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number
  ): Promise<readonly StoredRoomEventRecord[]> {
    return (this.#roomEvents.get(roomId) ?? [])
      .filter((event) => event.sequence > afterSequence && event.sequence <= throughSequence)
      .slice(0, limit);
  }

  public async getMatrixPrincipalByMxid(
    mxid: string
  ): Promise<MatrixPrincipalRecord | undefined> {
    const key = this.#matrixMxids.get(mxid);
    return key === undefined ? undefined : this.#matrixPrincipals.get(key);
  }

  public async getMatrixPrincipal(
    principalKind: MatrixPrincipalRecord["principalKind"],
    principalId: string
  ): Promise<MatrixPrincipalRecord | undefined> {
    return this.#matrixPrincipals.get(principalKey(principalKind, principalId));
  }

  public async putMatrixPrincipal(record: MatrixPrincipalRecord): Promise<void> {
    const key = principalKey(record.principalKind, record.principalId);
    const mxidOwner = this.#matrixMxids.get(record.mxid);
    if (mxidOwner !== undefined && mxidOwner !== key) {
      throw new Error(`Matrix principal MXID is already assigned: ${record.mxid}`);
    }
    this.#matrixPrincipals.set(key, record);
    this.#matrixMxids.set(record.mxid, key);
  }

  public async isMatrixTransactionComplete(transactionId: string): Promise<boolean> {
    return this.#matrixTransactions.has(transactionId);
  }

  public async completeMatrixTransaction(
    transactionId: string,
    _now: string
  ): Promise<boolean> {
    if (this.#matrixTransactions.has(transactionId)) {
      return false;
    }
    this.#matrixTransactions.add(transactionId);
    return true;
  }

  #aggregate(agent: AgentRecord, placement: PlacementRecord): AgentAggregate {
    const owner = this.#humans.get(agent.ownerHumanId);
    const operator = this.#humans.get(agent.operatorHumanId);
    if (owner === undefined || operator === undefined) {
      throw new Error(`Agent Human identity is missing: ${agent.id}`);
    }
    const credential = [...this.#agentCredentials.values()].find(
      (candidate) => candidate.agentId === agent.id &&
        candidate.placementId === placement.id
    );
    return {
      agent,
      placement,
      owner,
      operator,
      credentialStatus: credential?.status ?? "pending"
    };
  }
}

function identityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

function membershipKey(roomId: string, humanId: string): string {
  return `${roomId}\u0000${humanId}`;
}

function bindingKey(agentId: string, roomId: string): string {
  return `${agentId}\u0000${roomId}`;
}

function principalKey(kind: MatrixPrincipalRecord["principalKind"], id: string): string {
  return `${kind}\u0000${id}`;
}
