import * as v from "valibot";

export class ConsoleApiError extends Error {
  public constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ConsoleApiError";
  }
}

export async function requestJson<
  const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
>(
  input: RequestInfo | URL,
  schema: TSchema,
  init: RequestInit = {}
): Promise<v.InferOutput<TSchema>> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers
    }
  });
  const raw = await readJson(response);
  if (!response.ok) {
    const message = errorMessage(raw) ?? `HTTP ${response.status}`;
    throw new ConsoleApiError(message, response.status);
  }
  const parsed = v.safeParse(schema, raw);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const path = issue.path?.map((item) => String(item.key)).join(".");
    throw new ConsoleApiError(
      `Invalid Console API response${path ? ` at ${path}` : ""}: ${issue.message}`
    );
  }
  return parsed.output;
}

export function boundedError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ConsoleApiError(
      `Console API returned invalid JSON (HTTP ${response.status})`,
      response.status
    );
  }
}

function errorMessage(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || !("error" in raw)) return null;
  const error = raw.error;
  return typeof error === "string" && error ? error : null;
}
