import type {
  AgentAggregate,
  AgentAuthenticationRecord,
  AgentCredentialRecord,
  AgentRecord,
  AgentRoomBindingRecord,
  EnrollmentGrantRecord,
  PlacementRecord
} from "../../../../application/model.js";
import type {
  AgentRepository,
  CreateAgentInput,
  CreateAgentOutcome,
  RedeemEnrollmentInput,
  RedeemEnrollmentOutcome
} from "../../../../modules/agent/repository.js";
import {
  agentNameKey,
  bindingKey,
  MemoryRepositoryState
} from "./state.js";

export class MemoryAgentRepository implements AgentRepository {
  readonly #state: MemoryRepositoryState;

  public constructor(state: MemoryRepositoryState) {
    this.#state = state;
  }

  public async createOrResumeAgent(
    input: CreateAgentInput
  ): Promise<CreateAgentOutcome> {
    const nameKey = agentNameKey(input.agent.ownerHumanId, input.agent.name);
    const existingId = this.#state.agentNames.get(nameKey);
    if (existingId === undefined) {
      this.#state.agents.set(input.agent.id, input.agent);
      this.#state.agentNames.set(nameKey, input.agent.id);
      this.#state.placements.set(input.placement.id, input.placement);
      this.#state.enrollments.set(input.enrollment.id, input.enrollment);
      return {
        ok: true,
        value: {
          aggregate: this.#aggregate(input.agent, input.placement),
          enrollment: input.enrollment
        }
      };
    }
    const agent = this.#state.agents.get(existingId);
    if (agent === undefined) {
      throw new Error(`Agent name index is corrupt: ${input.agent.name}`);
    }
    if (agent.status !== "provisioning" && agent.status !== "active") {
      return { ok: false, reason: "agent_not_active" };
    }
    let placement = [...this.#state.placements.values()].find(
      (candidate) => candidate.agentId === agent.id &&
        (candidate.state === "pending" || candidate.state === "active")
    );
    if (placement === undefined || placement.deviceId !== input.device.device.id) {
      if (placement !== undefined) {
        this.#state.placements.set(placement.id, {
          ...placement,
          state: "superseded",
          supersededAt: input.now
        });
        for (const [id, enrollment] of this.#state.enrollments) {
          if (enrollment.placementId === placement.id &&
            (enrollment.status === "issued" || enrollment.status === "redeemed")) {
            this.#state.enrollments.set(id, { ...enrollment, status: "revoked" });
          }
        }
        for (const [id, credential] of this.#state.agentCredentials) {
          if (credential.placementId === placement.id && credential.status === "active") {
            this.#state.agentCredentials.set(id, {
              ...credential,
              status: "revoked",
              revokedAt: input.now
            });
          }
        }
      }
      const generation = Math.max(0, ...[...this.#state.placements.values()]
        .filter((candidate) => candidate.agentId === agent.id)
        .map((candidate) => candidate.generation)) + 1;
      placement = {
        ...input.placement,
        agentId: agent.id,
        generation
      };
      const replacementEnrollment = {
        ...input.enrollment,
        agentId: agent.id,
        placementId: placement.id
      };
      this.#state.placements.set(placement.id, placement);
      this.#state.enrollments.set(replacementEnrollment.id, replacementEnrollment);
      return {
        ok: true,
        value: {
          aggregate: this.#aggregate(agent, placement),
          enrollment: replacementEnrollment
        }
      };
    }
    const enrollment = [...this.#state.enrollments.values()].find(
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
    this.#state.enrollments.set(resumed.id, resumed);
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
    const enrollment = this.#state.enrollments.get(input.grantId);
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
      this.#state.enrollments.set(enrollment.id, { ...enrollment, status: "expired" });
      return { ok: false, reason: "expired" };
    }
    const agent = this.#state.agents.get(enrollment.agentId);
    const placement = this.#state.placements.get(enrollment.placementId);
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
      const credential = this.#state.agentCredentials.get(enrollment.credentialId);
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
    this.#state.agents.set(activeAgent.id, activeAgent);
    this.#state.placements.set(activePlacement.id, activePlacement);
    this.#state.enrollments.set(redeemed.id, redeemed);
    this.#state.agentCredentials.set(credential.id, credential);
    return {
      ok: true,
      value: {
        aggregate: this.#aggregate(activeAgent, activePlacement),
        credential
      }
    };
  }

  public async listAgentsForDevice(deviceId: string): Promise<readonly AgentAggregate[]> {
    return [...this.#state.placements.values()]
      .filter((placement) => placement.deviceId === deviceId &&
        (placement.state === "pending" || placement.state === "active"))
      .map((placement) => {
        const agent = this.#state.agents.get(placement.agentId);
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
    const credential = this.#state.agentCredentials.get(credentialId);
    if (
      credential === undefined ||
      credential.status !== "active" ||
      credential.revokedAt !== undefined ||
      (credential.expiresAt !== undefined &&
        Date.parse(credential.expiresAt) <= Date.parse(now))
    ) {
      return undefined;
    }
    const agent = this.#state.agents.get(credential.agentId);
    const placement = this.#state.placements.get(credential.placementId);
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
    const agent = this.#state.agents.get(agentId);
    if (agent === undefined) {
      return undefined;
    }
    const placement = [...this.#state.placements.values()].find(
      (candidate) => candidate.agentId === agentId &&
        (candidate.state === "pending" || candidate.state === "active")
    );
    return placement === undefined ? undefined : this.#aggregate(agent, placement);
  }

  public async rotateAgentCredential(
    agentId: string,
    placementId: string,
    credential: AgentCredentialRecord,
    now: string
  ): Promise<AgentCredentialRecord | undefined> {
    const placement = this.#state.placements.get(placementId);
    if (placement?.agentId !== agentId || placement.state !== "active") return undefined;
    const active = [...this.#state.agentCredentials.values()].filter(
      (candidate) => candidate.agentId === agentId && candidate.status === "active"
    );
    for (const candidate of active) {
      this.#state.agentCredentials.set(candidate.id, {
        ...candidate,
        status: "revoked",
        revokedAt: now
      });
    }
    const rotated = {
      ...credential,
      ...(active[0] === undefined ? {} : { rotatedFromCredentialId: active[0].id })
    };
    this.#state.agentCredentials.set(rotated.id, rotated);
    return rotated;
  }

  public async revokeAgentCredentials(agentId: string, now: string): Promise<number> {
    let revoked = 0;
    for (const credential of this.#state.agentCredentials.values()) {
      if (credential.agentId !== agentId || credential.status !== "active") continue;
      this.#state.agentCredentials.set(credential.id, {
        ...credential,
        status: "revoked",
        revokedAt: now
      });
      revoked += 1;
    }
    return revoked;
  }

  public async getAgentRoomBinding(
    agentId: string,
    roomId: string
  ): Promise<AgentRoomBindingRecord | undefined> {
    return this.#state.roomBindings.get(bindingKey(agentId, roomId));
  }

  public async putAgentRoomBinding(
    binding: AgentRoomBindingRecord
  ): Promise<AgentRoomBindingRecord> {
    const key = bindingKey(binding.agentId, binding.roomId);
    const existing = this.#state.roomBindings.get(key);
    if (existing !== undefined && existing.status === "active") {
      return existing;
    }
    this.#state.roomBindings.set(key, binding);
    return binding;
  }

  public async updateAgentRoomBinding(binding: AgentRoomBindingRecord): Promise<void> {
    const key = bindingKey(binding.agentId, binding.roomId);
    if (!this.#state.roomBindings.has(key)) {
      throw new Error(`Agent Room binding is missing: ${binding.agentId}/${binding.roomId}`);
    }
    this.#state.roomBindings.set(key, binding);
  }

  public async listAgentRoomBindings(
    agentId: string,
    activeOnly = false
  ): Promise<readonly AgentRoomBindingRecord[]> {
    return [...this.#state.roomBindings.values()]
      .filter((binding) => binding.agentId === agentId &&
        (!activeOnly || binding.status === "active"))
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
  }

  #aggregate(agent: AgentRecord, placement: PlacementRecord): AgentAggregate {
    const owner = this.#state.humans.get(agent.ownerHumanId);
    const operator = this.#state.humans.get(agent.operatorHumanId);
    if (owner === undefined || operator === undefined) {
      throw new Error(`Agent Human identity is missing: ${agent.id}`);
    }
    const credential = [...this.#state.agentCredentials.values()].find(
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
