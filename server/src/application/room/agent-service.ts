import { randomUUID } from "node:crypto";

import type {
  AgentRoomBindingSummary,
  AgentRoomWakeModeUpdate,
  RoomMessageSendRequest,
  RoomMessageSendResponse
} from "@rollerskate/protocol";

import type { HumanRecord } from "../../modules/trust/model.js";
import { ServerError } from "../../modules/shared/error.js";
import type { MatrixApplicationServiceGateway } from "./gateway.js";
import type {
  MatrixPrincipalRecord,
  RoomRecord
} from "./model.js";
import type { RoomRepository } from "./repository.js";
import type {
  AgentAuthenticationRecord,
  AgentRoomBindingRecord
} from "../../modules/agent/model.js";
import type { AgentRepository } from "../../modules/agent/repository.js";

export interface AgentRoomServiceOptions {
  readonly now?: () => Date;
}

export class AgentRoomService {
  readonly #repository: AgentRepository & RoomRepository;
  readonly #matrix: MatrixApplicationServiceGateway;
  readonly #options: AgentRoomServiceOptions;

  public constructor(
    repository: AgentRepository & RoomRepository,
    matrix: MatrixApplicationServiceGateway,
    options: AgentRoomServiceOptions = {}
  ) {
    this.#repository = repository;
    this.#matrix = matrix;
    this.#options = options;
  }

  public async invite(
    human: HumanRecord,
    roomId: string,
    agentId: string
  ): Promise<AgentRoomBindingSummary> {
    const room = await this.#requireRoom(roomId);
    await this.#requireMember(human, room);
    const agent = await this.#repository.getAgentAggregateById(agentId);
    if (agent === undefined || agent.agent.status !== "active") {
      throw new ServerError("agent_not_found", 404, "Agent was not found");
    }
    if (agent.agent.ownerHumanId !== human.id && agent.agent.operatorHumanId !== human.id) {
      throw new ServerError("forbidden", 403, "Only the Agent owner or operator may bind it");
    }
    const now = this.#now();
    const principal = await this.#ensurePrincipal("agent", agent.agent.id, agent.agent.name, now);
    if (room.visibility === "private") {
      const actor = await this.#ensurePrincipal("human", human.id, human.displayName, now);
      await this.#matrix.invite(room.matrixRoomId, actor.mxid, principal.mxid);
    }
    await this.#matrix.join(room.matrixRoomId, principal.mxid);
    return bindingSummary(await this.#repository.putAgentRoomBinding({
      id: randomUUID(),
      agentId: agent.agent.id,
      roomId: room.id,
      wakeMode: "mention_only",
      createdByHumanId: human.id,
      status: "active",
      createdAt: now,
      updatedAt: now
    }));
  }

  public async updateWakeMode(
    human: HumanRecord,
    roomId: string,
    agentId: string,
    update: AgentRoomWakeModeUpdate
  ): Promise<AgentRoomBindingSummary> {
    await this.#requireAgentAuthority(human, agentId);
    const binding = await this.#requireActiveBinding(agentId, roomId);
    const updated: AgentRoomBindingRecord = {
      ...binding,
      wakeMode: update.wakeMode,
      updatedAt: this.#now()
    };
    await this.#repository.updateAgentRoomBinding(updated);
    return bindingSummary(updated);
  }

  public async list(
    authentication: AgentAuthenticationRecord
  ): Promise<readonly AgentRoomBindingSummary[]> {
    return (await this.#repository.listAgentRoomBindings(
      authentication.agent.id,
      true
    )).map(bindingSummary);
  }

  public async leave(human: HumanRecord, roomId: string, agentId: string): Promise<void> {
    await this.#requireAgentAuthority(human, agentId);
    const room = await this.#requireRoom(roomId);
    const binding = await this.#requireActiveBinding(agentId, roomId);
    const principal = await this.#repository.getMatrixPrincipal("agent", agentId);
    if (principal !== undefined) {
      await this.#matrix.leave(room.matrixRoomId, principal.mxid);
    }
    const now = this.#now();
    await this.#repository.updateAgentRoomBinding({
      ...binding,
      status: "inactive",
      updatedAt: now,
      deactivatedAt: now
    });
  }

  public async sendMessage(
    authentication: AgentAuthenticationRecord,
    roomId: string,
    request: RoomMessageSendRequest
  ): Promise<RoomMessageSendResponse> {
    await this.#requireActiveBinding(authentication.agent.id, roomId);
    const room = await this.#requireRoom(roomId);
    const principal = await this.#repository.getMatrixPrincipal("agent", authentication.agent.id);
    if (principal === undefined) {
      throw new ServerError("matrix_principal_missing", 409, "Agent Matrix principal is missing");
    }
    const eventId = await this.#matrix.sendMessage({
      roomId: room.matrixRoomId,
      senderMxid: principal.mxid,
      transactionId: request.transactionId,
      body: request.body,
      ...(request.causalChainId === undefined ? {} : { causalChainId: request.causalChainId }),
      ...(request.causalHop === undefined ? {} : { causalHop: request.causalHop })
    });
    return { eventId, transactionId: request.transactionId };
  }

  async #ensurePrincipal(
    principalKind: MatrixPrincipalRecord["principalKind"],
    principalId: string,
    displayName: string,
    now: string
  ): Promise<MatrixPrincipalRecord> {
    const existing = await this.#repository.getMatrixPrincipal(principalKind, principalId);
    if (existing !== undefined) {
      return existing;
    }
    const record: MatrixPrincipalRecord = {
      principalKind,
      principalId,
      mxid: this.#matrix.mxidFor(principalKind, principalId),
      createdAt: now
    };
    await this.#matrix.ensurePrincipal(record.mxid, displayName);
    await this.#repository.putMatrixPrincipal(record);
    return record;
  }

  async #requireMember(human: HumanRecord, room: RoomRecord): Promise<void> {
    const membership = await this.#repository.getRoomMembership(room.id, human.id);
    if (membership?.status !== "active") {
      throw new ServerError(
        "room_membership_required",
        403,
        "Active Human Room membership is required"
      );
    }
  }

  async #requireAgentAuthority(human: HumanRecord, agentId: string): Promise<void> {
    const agent = await this.#repository.getAgentAggregateById(agentId);
    if (
      agent === undefined ||
      (agent.agent.ownerHumanId !== human.id && agent.agent.operatorHumanId !== human.id)
    ) {
      throw new ServerError("forbidden", 403, "Only the Agent owner or operator may change it");
    }
  }

  async #requireActiveBinding(
    agentId: string,
    roomId: string
  ): Promise<AgentRoomBindingRecord> {
    const binding = await this.#repository.getAgentRoomBinding(agentId, roomId);
    if (binding?.status !== "active") {
      throw new ServerError("room_binding_required", 403, "Active Agent Room binding is required");
    }
    return binding;
  }

  async #requireRoom(roomId: string): Promise<RoomRecord> {
    const room = await this.#repository.getRoom(roomId);
    if (room === undefined) {
      throw new ServerError("room_not_found", 404, "Room was not found");
    }
    return room;
  }

  #now(): string {
    return (this.#options.now ?? (() => new Date()))().toISOString();
  }
}

function bindingSummary(binding: AgentRoomBindingRecord): AgentRoomBindingSummary {
  return {
    id: binding.id,
    agentId: binding.agentId,
    roomId: binding.roomId,
    wakeMode: binding.wakeMode,
    status: binding.status,
    createdAt: binding.createdAt,
    createdByHumanId: binding.createdByHumanId,
    updatedAt: binding.updatedAt
  };
}
