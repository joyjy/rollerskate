import { createHash } from "node:crypto";

import type { RoomVisibility } from "@rollerskate/protocol";

import { ServerError } from "../../modules/shared/error.js";
import type { MatrixApplicationServiceGateway } from "../../application/room/gateway.js";

export type { MatrixApplicationServiceGateway } from "../../application/room/gateway.js";

const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;

export interface MatrixApplicationServiceOptions {
  readonly homeserverUrl: string;
  readonly serverName: string;
  readonly asToken: string;
  readonly fetch?: typeof fetch;
}

export class HttpMatrixApplicationServiceGateway
implements MatrixApplicationServiceGateway {
  readonly #homeserverUrl: string;
  readonly #asToken: string;
  readonly #fetch: typeof fetch;

  public readonly serverName: string;

  public constructor(options: MatrixApplicationServiceOptions) {
    this.#homeserverUrl = new URL(options.homeserverUrl).origin;
    this.serverName = options.serverName;
    this.#asToken = options.asToken;
    this.#fetch = options.fetch ?? fetch;
  }

  public mxidFor(principalKind: "human" | "agent", principalId: string): string {
    const digest = createHash("sha256").update(principalId, "utf8").digest("hex").slice(0, 32);
    return `@rs_${principalKind === "human" ? "h" : "a"}_${digest}:${this.serverName}`;
  }

  public async ensurePrincipal(mxid: string, displayName: string): Promise<void> {
    const localpart = localpartOf(mxid, this.serverName);
    const response = await this.#request("POST", "/_matrix/client/v3/register?kind=user", {
      type: "m.login.application_service",
      username: localpart
    }, [400]);
    if (response.status === 400) {
      const body = await readBoundedJson(response);
      if (!isErrorCode(body, "M_USER_IN_USE")) {
        throw matrixFailure(response.status, body);
      }
    } else {
      await readBoundedJson(response);
    }
    await readBoundedJson(await this.#request(
      "PUT",
      `/_matrix/client/v3/profile/${encodeURIComponent(mxid)}/displayname?user_id=${encodeURIComponent(mxid)}`,
      { displayname: displayName }
    ));
  }

  public async createRoom(input: {
    readonly creatorMxid: string;
    readonly name: string;
    readonly visibility: RoomVisibility;
  }): Promise<string> {
    const response = await this.#request(
      "POST",
      `/_matrix/client/v3/createRoom?user_id=${encodeURIComponent(input.creatorMxid)}`,
      {
        name: input.name,
        visibility: input.visibility,
        preset: input.visibility === "public" ? "public_chat" : "private_chat"
      }
    );
    const body = await readBoundedJson(response);
    if (typeof body.room_id !== "string" || body.room_id === "") {
      throw new ServerError("matrix_invalid_response", 502, "Matrix did not return a Room ID");
    }
    return body.room_id;
  }

  public async invite(roomId: string, actorMxid: string, inviteeMxid: string): Promise<void> {
    await readBoundedJson(await this.#request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite?user_id=${encodeURIComponent(actorMxid)}`,
      { user_id: inviteeMxid }
    ));
  }

  public async join(roomId: string, mxid: string): Promise<void> {
    await readBoundedJson(await this.#request(
      "POST",
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}?user_id=${encodeURIComponent(mxid)}`,
      {}
    ));
  }

  public async leave(roomId: string, mxid: string): Promise<void> {
    await readBoundedJson(await this.#request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave?user_id=${encodeURIComponent(mxid)}`,
      {}
    ));
  }

  public async sendMessage(input: {
    readonly roomId: string;
    readonly senderMxid: string;
    readonly transactionId: string;
    readonly body: string;
    readonly causalChainId?: string;
    readonly causalHop?: number;
  }): Promise<string> {
    const response = await this.#request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}` +
        `/send/m.room.message/${encodeURIComponent(input.transactionId)}` +
        `?user_id=${encodeURIComponent(input.senderMxid)}`,
      {
        msgtype: "m.text",
        body: input.body,
        ...(input.causalChainId === undefined || input.causalHop === undefined
          ? {}
          : {
              "org.rollerskate.causal": {
                chain_id: input.causalChainId,
                hop: input.causalHop
              }
            })
      }
    );
    const body = await readBoundedJson(response);
    if (typeof body.event_id !== "string" || body.event_id === "") {
      throw new ServerError("matrix_invalid_response", 502, "Matrix did not return an event ID");
    }
    return body.event_id;
  }

  async #request(
    method: string,
    path: string,
    body: Readonly<Record<string, unknown>>,
    allowedFailureStatuses: readonly number[] = []
  ): Promise<Response> {
    const response = await this.#fetch(new URL(path, this.#homeserverUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.#asToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
    });
    if (!response.ok && !allowedFailureStatuses.includes(response.status)) {
      throw matrixFailure(response.status, await readBoundedJson(response));
    }
    return response;
  }
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return {};
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    length += next.value.byteLength;
    if (length > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new ServerError("matrix_response_too_large", 502, "Matrix response is too large");
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ServerError("matrix_invalid_response", 502, "Matrix returned invalid JSON");
  }
}

function localpartOf(mxid: string, serverName: string): string {
  const suffix = `:${serverName}`;
  if (!mxid.startsWith("@") || !mxid.endsWith(suffix)) {
    throw new Error(`MXID is outside the configured server: ${mxid}`);
  }
  return mxid.slice(1, -suffix.length);
}

function isErrorCode(body: Readonly<Record<string, unknown>>, code: string): boolean {
  return body.errcode === code;
}

function matrixFailure(status: number, body: Readonly<Record<string, unknown>>): ServerError {
  const message = typeof body.error === "string" ? body.error.slice(0, 512) : "Matrix request failed";
  return new ServerError("matrix_request_failed", 502, `${message} (${status})`);
}
