import {
  agentCreateResponseSchema,
  agentCredentialIssuanceSchema,
  agentListSchema,
  agentRoomBindingListSchema,
  agentRoomBindingSummarySchema,
  agentSummarySchema,
  deviceCredentialIssuanceSchema,
  devicePairingCreateResponseSchema,
  devicePairingStatusSchema,
  deviceSummarySchema,
  roomListSchema,
  roomMessageSendResponseSchema,
  roomSummarySchema,
  type AgentCreateRequest,
  type AgentCreateResponse,
  type AgentCredentialIssuance,
  type AgentSummary,
  type AgentRoomBindingSummary,
  type AgentRoomWakeModeUpdate,
  type DeviceCredentialIssuance,
  type DevicePairingCreateRequest,
  type DevicePairingCreateResponse,
  type DevicePairingStatus,
  type DeviceSummary,
  type RoomSummary,
  type RoomVisibility,
  type RoomMessageSendResponse
} from "../../protocol.js";

const MAX_RESPONSE_BYTES = 1_048_576;

export class DeviceServerError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DeviceServerError";
  }
}

export interface DeviceServerClientOptions {
  readonly serverUrl: string;
  readonly credential?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export class DeviceServerClient {
  readonly #serverUrl: string;
  readonly #credential: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: DeviceServerClientOptions) {
    const url = new URL(options.serverUrl);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
    ) {
      throw new Error("Rollerskate Server URL must use https except on localhost");
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error("Rollerskate Server URL must be an origin without a path");
    }
    this.#serverUrl = url.origin;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
  }

  public createPairing(
    request: DevicePairingCreateRequest
  ): Promise<DevicePairingCreateResponse> {
    return this.#json("/api/device-pairings", {
      method: "POST",
      body: JSON.stringify(request)
    }, devicePairingCreateResponseSchema.parse);
  }

  public pairingStatus(pairingId: string): Promise<DevicePairingStatus> {
    return this.#json(
      `/api/device-pairings/${encodeURIComponent(pairingId)}`,
      { method: "GET" },
      devicePairingStatusSchema.parse
    );
  }

  public redeemPairing(
    pairingId: string,
    deviceId: string,
    verifier: string
  ): Promise<DeviceCredentialIssuance> {
    return this.#json(`/api/device-pairings/${encodeURIComponent(pairingId)}/redeem`, {
      method: "POST",
      body: JSON.stringify({ deviceId, verifier })
    }, deviceCredentialIssuanceSchema.parse);
  }

  public status(): Promise<DeviceSummary> {
    return this.#json("/api/device", { method: "GET" }, deviceSummarySchema.parse);
  }

  public async allowSubject(subject: string): Promise<void> {
    const response = await this.#request("/api/admin/allowlist", {
      method: "POST",
      body: JSON.stringify({ subject })
    });
    if (response.status !== 201) await throwResponseError(response);
  }

  public createAgent(request: AgentCreateRequest): Promise<AgentCreateResponse> {
    return this.#json("/api/agents", {
      method: "POST",
      body: JSON.stringify(request)
    }, agentCreateResponseSchema.parse);
  }

  public listAgents(): Promise<readonly AgentSummary[]> {
    return this.#json("/api/agents", { method: "GET" }, agentListSchema.parse);
  }

  public agentByName(name: string): Promise<AgentSummary> {
    return this.#json(
      `/api/agents/by-name/${encodeURIComponent(name)}`,
      { method: "GET" },
      agentSummarySchema.parse
    );
  }

  public redeemAgentEnrollment(
    enrollmentId: string,
    verifier: string
  ): Promise<AgentCredentialIssuance> {
    return this.#json(
      `/api/agent-enrollments/${encodeURIComponent(enrollmentId)}/redeem`,
      { method: "POST", body: JSON.stringify({ verifier }) },
      agentCredentialIssuanceSchema.parse
    );
  }

  public agentPrincipal(agentId: string): Promise<AgentSummary> {
    return this.#json(
      `/api/agent-principals/${encodeURIComponent(agentId)}`,
      { method: "GET" },
      agentSummarySchema.parse
    );
  }

  public createRoom(name: string, visibility: RoomVisibility): Promise<RoomSummary> {
    return this.#json("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name, visibility })
    }, roomSummarySchema.parse);
  }

  public listRooms(): Promise<readonly RoomSummary[]> {
    return this.#json("/api/rooms", { method: "GET" }, roomListSchema.parse);
  }

  public joinRoom(roomId: string): Promise<RoomSummary> {
    return this.#json(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      body: JSON.stringify({})
    }, roomSummarySchema.parse);
  }

  public inviteHuman(roomId: string, humanId: string): Promise<RoomSummary> {
    return this.#json(`/api/rooms/${encodeURIComponent(roomId)}/members`, {
      method: "POST",
      body: JSON.stringify({ humanId })
    }, roomSummarySchema.parse);
  }

  public sendRoomMessage(
    roomId: string,
    transactionId: string,
    body: string
  ): Promise<RoomMessageSendResponse> {
    return this.#json(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ transactionId, body })
    }, roomMessageSendResponseSchema.parse);
  }

  public inviteAgent(roomId: string, agentId: string): Promise<AgentRoomBindingSummary> {
    return this.#json(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
      method: "POST",
      body: JSON.stringify({ agentId })
    }, agentRoomBindingSummarySchema.parse);
  }

  public updateAgentWakeMode(
    roomId: string,
    agentId: string,
    wakeMode: AgentRoomWakeModeUpdate["wakeMode"]
  ): Promise<AgentRoomBindingSummary> {
    return this.#json(
      `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "PATCH", body: JSON.stringify({ wakeMode }) },
      agentRoomBindingSummarySchema.parse
    );
  }

  public async removeAgent(roomId: string, agentId: string): Promise<void> {
    const response = await this.#request(
      `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    );
    if (response.status !== 204) await throwResponseError(response);
  }

  public listAgentRoomBindings(agentId: string): Promise<readonly AgentRoomBindingSummary[]> {
    return this.#json(
      `/api/agent-principals/${encodeURIComponent(agentId)}/rooms`,
      { method: "GET" },
      agentRoomBindingListSchema.parse
    );
  }

  public async revoke(): Promise<void> {
    const response = await this.#request("/api/device", { method: "DELETE" });
    if (response.status !== 204) {
      await throwResponseError(response);
    }
  }

  async #json<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T
  ): Promise<T> {
    const response = await this.#request(path, init);
    if (!response.ok) {
      await throwResponseError(response);
    }
    return parse(await readBoundedJson(response));
  }

  #request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (this.#credential !== undefined) {
      headers.set("authorization", `Bearer ${this.#credential}`);
    }
    return this.#fetch(`${this.#serverUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.#timeoutMilliseconds)
    });
  }
}

async function throwResponseError(response: Response): Promise<never> {
  let code = `http_${response.status}`;
  let message = `Rollerskate Server returned HTTP ${response.status}`;
  try {
    const body = await readBoundedJson(response);
    if (isRecord(body) && typeof body.error === "string") {
      code = body.error;
    }
    if (isRecord(body) && typeof body.message === "string") {
      message = body.message;
    }
  } catch {
    // Preserve the bounded generic error.
  }
  throw new DeviceServerError(response.status, code, message);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) {
    throw new Error("Rollerskate Server response exceeds the 1 MiB limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Rollerskate Server response exceeds the 1 MiB limit");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Rollerskate Server response is not valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
