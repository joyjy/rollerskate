import { randomUUID } from "node:crypto";

import type {
  RoomCreateRequest,
  RoomHumanInviteRequest,
  RoomMessageSendRequest,
  RoomMessageSendResponse,
  RoomSummary
} from "@rollerskate/protocol";

import type { HumanRecord } from "../../modules/trust/model.js";
import type { TrustRepository } from "../../modules/trust/repository.js";
import type {
  MatrixPrincipalRecord,
  RoomMembershipRecord,
  RoomRecord
} from "./model.js";
import { toRoomSummary } from "./model.js";
import { ServerError } from "../../modules/shared/error.js";
import { encodeCursor } from "../../modules/event/service.js";
import type { MatrixApplicationServiceGateway } from "./gateway.js";
import type { RoomRepository } from "./repository.js";

export interface RoomServiceOptions {
  readonly now?: () => Date;
}

export class RoomService {
  readonly #repository: RoomRepository & TrustRepository;
  readonly #matrix: MatrixApplicationServiceGateway;
  readonly #options: RoomServiceOptions;

  public constructor(
    repository: RoomRepository & TrustRepository,
    matrix: MatrixApplicationServiceGateway,
    options: RoomServiceOptions = {}
  ) {
    this.#repository = repository;
    this.#matrix = matrix;
    this.#options = options;
  }

  public async createRoom(human: HumanRecord, request: RoomCreateRequest): Promise<RoomSummary> {
    const now = this.#now();
    const principal = await this.#ensurePrincipal("human", human.id, human.displayName, now);
    const matrixRoomId = await this.#matrix.createRoom({
      creatorMxid: principal.mxid,
      name: request.name,
      visibility: request.visibility
    });
    const room: RoomRecord = {
      id: randomUUID(),
      name: request.name,
      matrixRoomId,
      visibility: request.visibility,
      createdByHumanId: human.id,
      headSequence: 0,
      createdAt: now
    };
    const membership: RoomMembershipRecord = {
      roomId: room.id,
      humanId: human.id,
      role: "owner",
      canInvite: true,
      status: "active",
      createdAt: now
    };
    await this.#repository.createRoom(room, membership);
    return this.#summary(room, membership);
  }

  public async listRooms(human: HumanRecord): Promise<readonly RoomSummary[]> {
    return (await this.#repository.listRoomsForHuman(human.id)).map(
      ({ room, membership }) => this.#summary(room, membership)
    );
  }

  public async joinRoom(human: HumanRecord, roomId: string): Promise<RoomSummary> {
    const room = await this.#requireRoom(roomId);
    const existing = await this.#repository.getRoomMembership(room.id, human.id);
    if (
      room.visibility === "private" &&
      existing?.status !== "invited" && existing?.status !== "active"
    ) {
      throw new ServerError("room_invitation_required", 403, "Private Room invitation is required");
    }
    if (existing?.status === "active") {
      return this.#summary(room, existing);
    }
    const now = this.#now();
    const principal = await this.#ensurePrincipal("human", human.id, human.displayName, now);
    await this.#matrix.join(room.matrixRoomId, principal.mxid);
    const membership: RoomMembershipRecord = {
      roomId: room.id,
      humanId: human.id,
      role: "member",
      canInvite: false,
      status: "active",
      createdAt: existing?.createdAt ?? now
    };
    await this.#repository.putRoomMembership(membership);
    return this.#summary(room, membership);
  }

  public async inviteHuman(
    human: HumanRecord,
    roomId: string,
    request: RoomHumanInviteRequest
  ): Promise<RoomSummary> {
    const room = await this.#requireRoom(roomId);
    await this.#requireInviter(human, room);
    const invitee = await this.#repository.getHuman(request.humanId);
    if (invitee === undefined || invitee.status !== "active") {
      throw new ServerError("human_not_found", 404, "Human was not found");
    }
    const existing = await this.#repository.getRoomMembership(room.id, invitee.id);
    if (existing?.status === "active") {
      return this.#summary(room, existing);
    }
    const now = this.#now();
    const actor = await this.#ensurePrincipal("human", human.id, human.displayName, now);
    const principal = await this.#ensurePrincipal("human", invitee.id, invitee.displayName, now);
    await this.#matrix.invite(room.matrixRoomId, actor.mxid, principal.mxid);
    const membership: RoomMembershipRecord = {
      roomId: room.id,
      humanId: invitee.id,
      role: "member",
      canInvite: false,
      status: "invited",
      invitedByHumanId: human.id,
      createdAt: existing?.createdAt ?? now
    };
    await this.#repository.putRoomMembership(membership);
    return this.#summary(room, membership);
  }

  public async sendHumanMessage(
    human: HumanRecord,
    roomId: string,
    request: RoomMessageSendRequest
  ): Promise<RoomMessageSendResponse> {
    const room = await this.#requireRoom(roomId);
    const membership = await this.#repository.getRoomMembership(roomId, human.id);
    if (membership?.status !== "active") {
      throw new ServerError(
        "room_membership_required",
        403,
        "Active Human Room membership is required"
      );
    }
    const principal = await this.#ensurePrincipal("human", human.id, human.displayName, this.#now());
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

  async #requireInviter(human: HumanRecord, room: RoomRecord): Promise<void> {
    const membership = await this.#repository.getRoomMembership(room.id, human.id);
    if (membership?.status !== "active" || !membership.canInvite) {
      throw new ServerError("forbidden", 403, "Active Room inviter membership is required");
    }
  }

  async #requireRoom(roomId: string): Promise<RoomRecord> {
    const room = await this.#repository.getRoom(roomId);
    if (room === undefined) {
      throw new ServerError("room_not_found", 404, "Room was not found");
    }
    return room;
  }

  #summary(room: RoomRecord, membership?: RoomMembershipRecord): RoomSummary {
    return toRoomSummary(room, encodeCursor(room.id, room.headSequence), membership);
  }

  #now(): string {
    return (this.#options.now ?? (() => new Date()))().toISOString();
  }
}
