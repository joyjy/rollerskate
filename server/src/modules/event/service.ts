import type {
  MatrixApplicationServiceEvent,
  MatrixApplicationServiceTransaction,
  RoomEventPage,
  RoomHead,
  RoomStreamEvent
} from "@rollerskate/protocol";

import type { AgentAuthenticationRecord, AgentRoomBindingRecord } from "../agent/model.js";
import { ServerError } from "../shared/error.js";
import { RoomEventBroker, type RoomStreamListener } from "./broker.js";
import { toRoomEventProjection } from "./model.js";
import type { EventRepository } from "./repository.js";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

export interface EventServiceOptions {
  readonly now?: () => Date;
}

export class EventService {
  readonly #repository: EventRepository;
  readonly #broker: RoomEventBroker;
  readonly #options: EventServiceOptions;

  public constructor(
    repository: EventRepository,
    broker: RoomEventBroker,
    options: EventServiceOptions = {}
  ) {
    this.#repository = repository;
    this.#broker = broker;
    this.#options = options;
  }

  public async head(
    authentication: AgentAuthenticationRecord,
    roomId: string
  ): Promise<RoomHead> {
    await this.#requireActiveBinding(authentication.agent.id, roomId);
    const room = await this.#requireRoom(roomId);
    return { roomId, head: encodeCursor(roomId, room.headSequence) };
  }

  public async events(
    authentication: AgentAuthenticationRecord,
    roomId: string,
    input: { readonly after?: string; readonly through?: string; readonly limit?: number }
  ): Promise<RoomEventPage> {
    await this.#requireActiveBinding(authentication.agent.id, roomId);
    const room = await this.#requireRoom(roomId);
    const after = input.after === undefined ? 0 : decodeCursor(input.after, roomId);
    const through = input.through === undefined
      ? room.headSequence
      : decodeCursor(input.through, roomId);
    if (after > through || through > room.headSequence) {
      throw new ServerError("invalid_room_range", 400, "Room cursor range is invalid");
    }
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new ServerError("invalid_limit", 400, "limit must be from 1 to 100");
    }
    const records = await this.#repository.listRoomEvents(roomId, after, through, limit);
    const lastSequence = records.at(-1)?.sequence ?? after;
    return {
      roomId,
      through: encodeCursor(roomId, through),
      events: records.map((record) =>
        toRoomEventProjection(record, encodeCursor(roomId, record.sequence))),
      ...(lastSequence < through
        ? { nextCursor: encodeCursor(roomId, lastSequence) }
        : {}),
      complete: lastSequence >= through
    };
  }

  public async subscribe(
    authentication: AgentAuthenticationRecord,
    roomId: string,
    listener: RoomStreamListener
  ): Promise<() => void> {
    await this.#requireActiveBinding(authentication.agent.id, roomId);
    return this.#broker.subscribe(authentication.agent.id, roomId, listener);
  }

  public async ingestMatrixTransaction(
    transactionId: string,
    transaction: MatrixApplicationServiceTransaction
  ): Promise<void> {
    for (const event of transaction.events) {
      await this.#ingestMatrixEvent(event);
    }
    await this.#repository.completeMatrixTransaction(transactionId, this.#now());
  }

  async #ingestMatrixEvent(event: MatrixApplicationServiceEvent): Promise<void> {
    if (event.type !== "m.room.message") {
      return;
    }
    const room = await this.#repository.getRoomByMatrixId(event.room_id);
    if (room === undefined) {
      return;
    }
    const principal = await this.#repository.getMatrixPrincipalByMxid(event.sender);
    const appended = await this.#repository.appendRoomEvent({
      roomId: room.id,
      matrixEventId: event.event_id,
      event: {
        protocolVersion: 1,
        eventId: event.event_id,
        type: event.type,
        occurredAt: new Date(event.origin_server_ts).toISOString(),
        source: principal === undefined
          ? { kind: "server", id: event.sender }
          : { kind: principal.principalKind, id: principal.principalId },
        payload: event.content,
        adapter: {
          transport: "matrix",
          metadata: {
            matrixRoomId: event.room_id,
            matrixEventId: event.event_id,
            senderMxid: event.sender
          }
        }
      }
    });
    if (!appended.created) {
      return;
    }
    const mentioned = mentionedMxids(event);
    for (const binding of appended.candidateBindings) {
      const agentPrincipal = await this.#repository.getMatrixPrincipal("agent", binding.agentId);
      if (
        binding.wakeMode === "disabled" ||
        (binding.wakeMode === "mention_only" &&
          (agentPrincipal === undefined || !mentioned.has(agentPrincipal.mxid)))
      ) {
        continue;
      }
      const streamEvent: RoomStreamEvent = {
        bindingId: binding.id,
        projection: toRoomEventProjection(
          appended.record,
          encodeCursor(room.id, appended.record.sequence)
        )
      };
      this.#broker.publish(binding.agentId, room.id, streamEvent);
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

  async #requireRoom(roomId: string) {
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

export function encodeCursor(roomId: string, sequence: number): string {
  return `r1.${Buffer.from(JSON.stringify([roomId, sequence]), "utf8").toString("base64url")}`;
}

export function decodeCursor(cursor: string, expectedRoomId: string): number {
  if (!/^r1\.[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ServerError("invalid_room_cursor", 400, "Room cursor is invalid");
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor.slice(3), "base64url").toString("utf8")
    ) as unknown;
    if (
      !Array.isArray(decoded) || decoded.length !== 2 ||
      decoded[0] !== expectedRoomId ||
      !Number.isSafeInteger(decoded[1]) || decoded[1] < 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return decoded[1];
  } catch {
    throw new ServerError("invalid_room_cursor", 400, "Room cursor is invalid");
  }
}

function mentionedMxids(event: MatrixApplicationServiceEvent): ReadonlySet<string> {
  const mentions = event.content["m.mentions"];
  if (typeof mentions !== "object" || mentions === null || Array.isArray(mentions)) {
    return new Set();
  }
  const userIds = mentions.user_ids;
  return new Set(Array.isArray(userIds)
    ? userIds.filter((value): value is string => typeof value === "string")
    : []);
}
