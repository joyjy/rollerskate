const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export interface VikunjaProviderResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly value: unknown;
}

export type VikunjaFetch = typeof fetch;

export class VikunjaProviderError extends Error {
  public readonly status: number;
  public readonly providerCode: number | undefined;

  public constructor(status: number, providerCode?: number) {
    super(`Vikunja request failed with HTTP ${status}`);
    this.status = status;
    this.providerCode = providerCode;
  }
}

export class VikunjaProviderClient {
  readonly #baseUrl: URL;
  readonly #token: () => string;
  readonly #fetch: VikunjaFetch;

  public constructor(input: {
    readonly endpoint: string;
    readonly token: () => string;
    readonly fetch?: VikunjaFetch;
  }) {
    this.#baseUrl = validateEndpoint(input.endpoint);
    this.#token = input.token;
    this.#fetch = input.fetch ?? fetch;
  }

  public async get(path: string): Promise<VikunjaProviderResponse> {
    return this.#request("GET", path);
  }

  public async put(path: string, body: unknown): Promise<VikunjaProviderResponse> {
    return this.#request("PUT", path, body);
  }

  public async post(path: string, body: unknown): Promise<VikunjaProviderResponse> {
    return this.#request("POST", path, body);
  }

  public async delete(path: string): Promise<VikunjaProviderResponse> {
    return this.#request("DELETE", path);
  }

  async #request(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<VikunjaProviderResponse> {
    if (!path.startsWith("/") || path.includes("\0")) {
      throw new Error("Vikunja API path is invalid");
    }
    const token = this.#token();
    if (token.trim() === "" || token.length > 16_384) {
      throw new Error("Vikunja credential is unavailable");
    }
    const url = new URL(`/api/v1${path}`, this.#baseUrl);
    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000)
    });
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("Vikunja response exceeds the bounded transport limit");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("Vikunja response exceeds the bounded transport limit");
    }
    const value = text === "" ? {} : parseJson(text);
    if (!response.ok) {
      throw new VikunjaProviderError(response.status, providerErrorCode(value));
    }
    return { status: response.status, headers: response.headers, value };
  }
}

function validateEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("Vikunja endpoint must not contain credentials, query, or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Vikunja endpoint must use HTTPS unless it is loopback");
  }
  return url;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Vikunja returned invalid JSON");
  }
}

function providerErrorCode(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "number" && Number.isInteger(code) ? code : undefined;
}
