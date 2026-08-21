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

export interface ServerClientOptions {
  readonly serverUrl: string;
  readonly credential?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export class ServerHttpTransport {
  readonly #serverUrl: string;
  readonly #credential: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: ServerClientOptions) {
    const url = new URL(options.serverUrl);
    if (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
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

  public async json<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T
  ): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) await throwResponseError(response);
    return parse(await readBoundedJson(response));
  }

  public request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
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

export async function throwResponseError(response: Response): Promise<never> {
  let code = `http_${response.status}`;
  let message = `Rollerskate Server returned HTTP ${response.status}`;
  try {
    const body = await readBoundedJson(response);
    if (isRecord(body) && typeof body.error === "string") code = body.error;
    if (isRecord(body) && typeof body.message === "string") message = body.message;
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
