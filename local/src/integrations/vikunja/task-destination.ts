import type { RuntimeDestinationAdapter } from "../../core/runtime/handlers.js";
import {
  VikunjaProviderClient,
  type VikunjaFetch
} from "./provider-client.js";

const MAX_COMMENT_BYTES = 16_384;

export interface VikunjaRunResultDestination {
  readonly schemaVersion: "RunResultDestination@2";
  readonly destinationId: string;
  readonly delivery: {
    readonly kind: "vikunja-task";
    readonly address: { readonly taskUrl: string };
  };
}

export function createVikunjaRunResultDestination(
  destinationId: string,
  taskUrl: string
): VikunjaRunResultDestination {
  if (destinationId.trim() === "" || destinationId.length > 256) {
    throw new Error("Vikunja result destination id is invalid");
  }
  return {
    schemaVersion: "RunResultDestination@2",
    destinationId,
    delivery: {
      kind: "vikunja-task",
      address: { taskUrl: parseVikunjaTaskUrl(taskUrl) }
    }
  };
}

export function normalizeLegacyVikunjaRunResultDestination(input: string): string {
  let binding: unknown;
  try {
    binding = JSON.parse(input) as unknown;
  } catch {
    return input;
  }
  if (!isRecord(binding) || !isRecord(binding.resultDestination) ||
    binding.resultDestination.schemaVersion !== "VikunjaTaskResultDestination@1") {
    return input;
  }
  const legacy = binding.resultDestination;
  const keys = Object.keys(legacy);
  if (keys.length !== 3 ||
    !["schemaVersion", "destinationId", "taskUrl"].every((key) => keys.includes(key)) ||
    typeof legacy.destinationId !== "string" || typeof legacy.taskUrl !== "string") {
    throw new Error("VikunjaTaskResultDestination@1 is invalid");
  }
  return JSON.stringify({
    ...binding,
    resultDestination: createVikunjaRunResultDestination(
      legacy.destinationId,
      legacy.taskUrl
    )
  });
}

export function vikunjaRunResultDelivery(destination: {
  readonly schemaVersion: string;
  readonly delivery: {
    readonly kind: string;
    readonly address: Readonly<Record<string, string>>;
  };
}): {
  readonly kind: "vikunja-task";
  readonly address: { readonly taskUrl: string };
  readonly taskUrl: string;
} {
  if (destination.schemaVersion !== "RunResultDestination@2" ||
    destination.delivery.kind !== "vikunja-task" ||
    Object.keys(destination.delivery.address).length !== 1) {
    throw new Error("Steward result destination is not a Vikunja Task destination");
  }
  const taskUrl = parseVikunjaTaskUrl(destination.delivery.address.taskUrl);
  return { kind: "vikunja-task", address: { taskUrl }, taskUrl };
}

export class VikunjaTaskDestinationAdapter implements RuntimeDestinationAdapter {
  public readonly kind = "vikunja-task" as const;
  readonly #endpointOrigin: string;
  readonly #client: VikunjaProviderClient;

  public constructor(options: {
    readonly endpoint: string;
    readonly token: () => string;
    readonly fetch?: VikunjaFetch;
  }) {
    this.#client = new VikunjaProviderClient({
      endpoint: options.endpoint,
      token: options.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
    this.#endpointOrigin = new URL(options.endpoint).origin;
  }

  public async deliver(
    input: Parameters<RuntimeDestinationAdapter["deliver"]>[0]
  ): Promise<{ readonly receipt: string }> {
    const taskUrl = parseVikunjaTaskUrl(input.destination.address.taskUrl);
    const url = new URL(taskUrl);
    if (url.origin !== this.#endpointOrigin) {
      throw new Error("Vikunja Task destination origin does not match the configured endpoint");
    }
    const taskId = taskIdFromUrl(url);
    const body = deliveryBody(input.delivery.payload);
    const marker = `<!-- rollerskate-delivery:${input.delivery.deliveryId} -->`;
    const comment = `${body}\n\n${marker}`;
    if (Buffer.byteLength(comment, "utf8") > MAX_COMMENT_BYTES) {
      throw new Error(`Vikunja Task comment exceeds ${MAX_COMMENT_BYTES} bytes`);
    }
    const existing = await findComment(this.#client, taskId, marker);
    if (existing !== undefined) return { receipt: `vikunja-comment:${existing}` };

    await this.#client.put(`/tasks/${taskId}/comments`, { comment });
    const confirmed = await findComment(this.#client, taskId, marker);
    if (confirmed === undefined) {
      throw new Error("Vikunja comment readback did not confirm the Delivery marker");
    }
    return { receipt: `vikunja-comment:${confirmed}` };
  }
}

export function parseVikunjaTaskUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 2_048) {
    throw new Error("Vikunja Task destination URL is invalid");
  }
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    !/(?:^|\/)tasks\/[1-9][0-9]*\/?$/u.test(url.pathname)) {
    throw new Error("Vikunja Task destination must be an HTTPS or loopback Task URL");
  }
  url.hash = "";
  return url.toString();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskIdFromUrl(url: URL): number {
  const match = url.pathname.match(/(?:^|\/)tasks\/([1-9][0-9]*)\/?$/u);
  const taskId = Number(match?.[1]);
  if (!Number.isSafeInteger(taskId)) throw new Error("Vikunja Task URL id is invalid");
  return taskId;
}

function deliveryBody(payload: Readonly<Record<string, unknown>>): string {
  if (payload.schemaVersion !== "VikunjaTaskComment@1" ||
    typeof payload.runId !== "string" || payload.runId.trim() === "" ||
    typeof payload.body !== "string" || payload.body.trim() === "") {
    throw new Error("Vikunja Task Delivery payload is invalid");
  }
  return payload.body.trim();
}

async function findComment(
  client: VikunjaProviderClient,
  taskId: number,
  marker: string
): Promise<number | undefined> {
  const response = await client.get(
    `/tasks/${taskId}/comments?sort_by=id&order_by=desc&per_page=100`
  );
  if (!Array.isArray(response.value)) throw new Error("Vikunja comment page is invalid");
  for (const value of response.value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const comment = value as Readonly<Record<string, unknown>>;
    if (typeof comment.comment !== "string" || !comment.comment.includes(marker)) continue;
    if (typeof comment.id !== "number" || !Number.isSafeInteger(comment.id) || comment.id <= 0) {
      throw new Error("Vikunja matching comment id is invalid");
    }
    return comment.id;
  }
  return undefined;
}
