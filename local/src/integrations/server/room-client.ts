import {
  agentRoomBindingListSchema,
  roomEventPageSchema,
  roomHeadSchema,
  roomMessageSendResponseSchema,
  type RoomEventPage,
  type AgentRoomBindingSummary,
  type RoomHead
} from "@rollerskate/protocol";

import { readBoundedJson, readResponsePrefix } from "../matrix/bounded-response.js";
import type { RoomHistorySource, RoomMessagePublisher } from "../matrix/room-contract.js";

export interface RoomServerClientOptions {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly credential: string;
  readonly timeoutMilliseconds?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: typeof fetch;
}

export class RoomServerClient implements RoomHistorySource, RoomMessagePublisher {
  readonly #agentId: string;
  readonly #baseUrl: URL;
  readonly #credential: string;
  readonly #fetch: typeof fetch;
  readonly #maxResponseBytes: number;
  readonly #timeoutMilliseconds: number;

  public constructor(options: RoomServerClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    const insecureLocalhost = options.allowInsecureHttp === true &&
      this.#baseUrl.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(this.#baseUrl.hostname);
    if (this.#baseUrl.protocol !== "https:" && !insecureLocalhost) {
      throw new Error("Room Server must use https");
    }
    requireText(options.agentId, "agentId");
    requireText(options.credential, "credential");
    this.#agentId = options.agentId;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMilliseconds = bounded(options.timeoutMilliseconds ?? 10_000, 1, 60_000,
      "timeoutMilliseconds");
    this.#maxResponseBytes = bounded(options.maxResponseBytes ?? 1_048_576, 1, 4_194_304,
      "maxResponseBytes");
  }

  public async head(roomId: string): Promise<RoomHead> {
    return roomHeadSchema.parse(await this.#json("GET", this.#path(roomId, "head")));
  }

  public async bindings(): Promise<readonly AgentRoomBindingSummary[]> {
    const url = new URL(this.#baseUrl);
    url.pathname = `/api/agent-principals/${encodeURIComponent(this.#agentId)}/rooms`;
    url.search = "";
    return agentRoomBindingListSchema.parse(await this.#json("GET", url));
  }

  public async events(input: {
    readonly roomId: string;
    readonly after?: string;
    readonly through: string;
    readonly limit: number;
  }): Promise<RoomEventPage> {
    const url = this.#path(input.roomId, "events");
    if (input.after !== undefined) url.searchParams.set("after", input.after);
    url.searchParams.set("through", input.through);
    url.searchParams.set("limit", String(input.limit));
    return roomEventPageSchema.parse(await this.#json("GET", url));
  }

  public async send(input: {
    readonly agentId: string;
    readonly roomId: string;
    readonly transactionId: string;
    readonly body: string;
    readonly causalChainId: string;
    readonly causalHop: number;
  }): Promise<{ readonly eventId: string }> {
    if (input.agentId !== this.#agentId) {
      throw new Error(`Room Server client cannot publish as Agent ${input.agentId}`);
    }
    const response = roomMessageSendResponseSchema.parse(await this.#json(
      "POST",
      this.#path(input.roomId, "messages"),
      {
        transactionId: input.transactionId,
        body: input.body,
        causalChainId: input.causalChainId,
        causalHop: input.causalHop
      }
    ));
    return { eventId: response.eventId };
  }

  #path(roomId: string, action: string): URL {
    requireText(roomId, "roomId");
    const url = new URL(this.#baseUrl);
    url.pathname = `/api/agent-principals/${encodeURIComponent(this.#agentId)}` +
      `/rooms/${encodeURIComponent(roomId)}/${action}`;
    url.search = "";
    return url;
  }

  async #json(method: "GET" | "POST", url: URL, body?: unknown): Promise<unknown> {
    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.#credential}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.#timeoutMilliseconds)
    });
    if (!response.ok) {
      const detail = (await readResponsePrefix(response, 4_096)).trim();
      throw new Error(`Room Server request failed with HTTP ${response.status}` +
        (detail === "" ? "" : `: ${detail}`));
    }
    return readBoundedJson(response, this.#maxResponseBytes, "Room Server response");
  }
}

export class RoomServerPublisherRouter implements RoomMessagePublisher {
  readonly #clients: ReadonlyMap<string, RoomMessagePublisher>;

  public constructor(clients: ReadonlyMap<string, RoomMessagePublisher>) {
    this.#clients = clients;
  }

  public send(input: Parameters<RoomMessagePublisher["send"]>[0]): Promise<{ readonly eventId: string }> {
    const client = this.#clients.get(input.agentId);
    if (client === undefined) throw new Error(`Room publisher is missing for Agent ${input.agentId}`);
    return client.send(input);
  }
}

function requireText(value: string, field: string): void {
  if (value.trim() === "") throw new Error(`${field} must be non-empty`);
}

function bounded(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}
