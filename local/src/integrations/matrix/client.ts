import {
  readBoundedJson,
  readResponsePrefix
} from "./bounded-response.js";

export interface MatrixClientConfig {
  readonly homeserver: string;
  readonly accessToken: string;
  readonly timeoutMilliseconds: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: typeof fetch;
}

export interface MatrixTextMessage {
  readonly roomId: string;
  readonly transactionId: string;
  readonly body: string;
  readonly mentionedUserIds?: readonly string[];
  readonly replyToEventId?: string;
  readonly threadRootEventId?: string;
}

export interface MatrixSendReceipt {
  readonly eventId: string;
  readonly roomId: string;
  readonly transactionId: string;
}

export interface MatrixIdentity {
  readonly userId: string;
  readonly deviceId?: string;
}

export interface MatrixReplyRoute {
  readonly roomId: string;
  readonly replyToEventId: string;
  readonly threadRootEventId?: string;
}

export function formatMatrixReplyRoute(route: MatrixReplyRoute): string {
  requireNonEmpty(route.roomId, "roomId");
  requireNonEmpty(route.replyToEventId, "replyToEventId");
  if (route.threadRootEventId !== undefined) {
    requireNonEmpty(route.threadRootEventId, "threadRootEventId");
  }
  const query = new URLSearchParams({ reply: route.replyToEventId });
  if (route.threadRootEventId !== undefined) {
    query.set("thread", route.threadRootEventId);
  }
  return `matrix:${encodeURIComponent(route.roomId)}?${query.toString()}`;
}

export function parseMatrixReplyRoute(value: string): MatrixReplyRoute {
  if (!value.startsWith("matrix:")) {
    throw new Error("reply route is not a Matrix route");
  }
  const separator = value.indexOf("?");
  if (separator < 0) {
    throw new Error("Matrix reply route is missing query parameters");
  }
  const roomId = decodeURIComponent(value.slice("matrix:".length, separator));
  const query = new URLSearchParams(value.slice(separator + 1));
  const replyToEventId = query.get("reply") ?? "";
  const threadRootEventId = query.get("thread") ?? undefined;
  requireNonEmpty(roomId, "roomId");
  requireNonEmpty(replyToEventId, "replyToEventId");
  return {
    roomId,
    replyToEventId,
    ...(threadRootEventId === undefined ? {} : { threadRootEventId })
  };
}

export class MatrixClient {
  readonly #accessToken: string;
  readonly #fetch: typeof fetch;
  readonly #homeserver: URL;
  readonly #maxResponseBytes: number;
  readonly #timeoutMilliseconds: number;

  public constructor(config: MatrixClientConfig) {
    this.#homeserver = new URL(config.homeserver);
    if (
      this.#homeserver.protocol !== "https:" &&
      !(config.allowInsecureHttp === true && this.#homeserver.protocol === "http:")
    ) {
      throw new Error("Matrix homeserver must use https");
    }
    requireNonEmpty(config.accessToken, "accessToken");
    if (
      !Number.isInteger(config.timeoutMilliseconds) ||
      config.timeoutMilliseconds < 1 ||
      config.timeoutMilliseconds > 60_000
    ) {
      throw new Error("timeoutMilliseconds must be between 1 and 60000");
    }
    this.#accessToken = config.accessToken;
    this.#fetch = config.fetch ?? fetch;
    const maxResponseBytes = config.maxResponseBytes ?? 1_048_576;
    if (
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 4_194_304
    ) {
      throw new Error("maxResponseBytes must be between 1 and 4194304");
    }
    this.#maxResponseBytes = maxResponseBytes;
    this.#timeoutMilliseconds = config.timeoutMilliseconds;
  }

  public async sendText(message: MatrixTextMessage): Promise<MatrixSendReceipt> {
    requireNonEmpty(message.roomId, "roomId");
    requireNonEmpty(message.transactionId, "transactionId");
    requireNonEmpty(message.body, "body");
    if (message.mentionedUserIds !== undefined) {
      if (message.mentionedUserIds.length < 1 || message.mentionedUserIds.length > 100) {
        throw new Error("mentionedUserIds must contain between 1 and 100 users");
      }
      for (const userId of message.mentionedUserIds) {
        requireNonEmpty(userId, "mentionedUserIds");
      }
    }
    if (message.replyToEventId !== undefined) {
      requireNonEmpty(message.replyToEventId, "replyToEventId");
    }
    if (message.threadRootEventId !== undefined) {
      requireNonEmpty(message.threadRootEventId, "threadRootEventId");
    }
    const url = new URL(this.#homeserver);
    url.pathname = [
      "",
      "_matrix",
      "client",
      "v3",
      "rooms",
      encodeURIComponent(message.roomId),
      "send",
      "m.room.message",
      encodeURIComponent(message.transactionId)
    ].join("/");
    const response = await this.#fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(messageContent(message)),
      signal: AbortSignal.timeout(this.#timeoutMilliseconds)
    });
    if (!response.ok) {
      const detail = (await readResponsePrefix(response, 4_096)).trim();
      throw new Error(
        `Matrix send failed with HTTP ${response.status}` +
        (detail === "" ? "" : `: ${detail}`)
      );
    }
    const body = await readBoundedJson<{ event_id?: unknown }>(
      response,
      this.#maxResponseBytes,
      "Matrix send response"
    );
    if (typeof body.event_id !== "string" || body.event_id.trim() === "") {
      throw new Error("Matrix send response is missing event_id");
    }
    return {
      eventId: body.event_id,
      roomId: message.roomId,
      transactionId: message.transactionId
    };
  }

  public async whoAmI(): Promise<MatrixIdentity> {
    const url = new URL(this.#homeserver);
    url.pathname = "/_matrix/client/v3/account/whoami";
    const response = await this.#fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(this.#timeoutMilliseconds)
    });
    if (!response.ok) {
      const detail = (await readResponsePrefix(response, 4_096)).trim();
      throw new Error(
        `Matrix whoami failed with HTTP ${response.status}` +
        (detail === "" ? "" : `: ${detail}`)
      );
    }
    const body = await readBoundedJson<{
      user_id?: unknown;
      device_id?: unknown;
    }>(response, this.#maxResponseBytes, "Matrix whoami response");
    if (typeof body.user_id !== "string" || body.user_id.trim() === "") {
      throw new Error("Matrix whoami response is missing user_id");
    }
    return {
      userId: body.user_id,
      ...(typeof body.device_id === "string" && body.device_id.trim() !== ""
        ? { deviceId: body.device_id }
        : {})
    };
  }

  public async joinedRoomIds(): Promise<readonly string[]> {
    const url = new URL(this.#homeserver);
    url.pathname = "/_matrix/client/v3/joined_rooms";
    const response = await this.#fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(this.#timeoutMilliseconds)
    });
    if (!response.ok) {
      const detail = (await readResponsePrefix(response, 4_096)).trim();
      throw new Error(
        `Matrix joined_rooms failed with HTTP ${response.status}` +
        (detail === "" ? "" : `: ${detail}`)
      );
    }
    const body = await readBoundedJson<{ joined_rooms?: unknown }>(
      response,
      this.#maxResponseBytes,
      "Matrix joined_rooms response"
    );
    if (
      !Array.isArray(body.joined_rooms) ||
      !body.joined_rooms.every(
        (roomId) => typeof roomId === "string" && roomId.trim() !== ""
      )
    ) {
      throw new Error("Matrix joined_rooms response is malformed");
    }
    return body.joined_rooms as string[];
  }
}

function messageContent(message: MatrixTextMessage): Record<string, unknown> {
  const replyTo = message.replyToEventId;
  const threadRoot = message.threadRootEventId;
  return {
    msgtype: "m.text",
    body: message.body,
    ...(message.mentionedUserIds === undefined
      ? {}
      : { "m.mentions": { user_ids: [...new Set(message.mentionedUserIds)] } }),
    ...(threadRoot === undefined && replyTo === undefined
      ? {}
      : {
          "m.relates_to": threadRoot === undefined
            ? { "m.in_reply_to": { event_id: replyTo } }
            : {
                rel_type: "m.thread",
                event_id: threadRoot,
                is_falling_back: true,
                "m.in_reply_to": { event_id: replyTo ?? threadRoot }
              }
        })
  };
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
}
