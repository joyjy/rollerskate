import type { IncomingMessage, ServerResponse } from "node:http";
import type { ListPageInput } from "../../application/list-page.js";

export type ConsoleRequestMarker = string | readonly string[] | undefined;

export async function readJsonBody(
  request: IncomingMessage
): Promise<Readonly<Record<string, unknown>>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body, "utf8") > 65_536) {
      throw new Error("request_body_too_large");
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(body || "{}") as unknown;
  } catch {
    throw new Error("request_body_must_be_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request_body_must_be_object");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function requireString(
  value: Readonly<Record<string, unknown>>,
  field: string
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return candidate;
}

export function optionalStringArray(
  value: Readonly<Record<string, unknown>>,
  field: string
): readonly string[] {
  const candidate = value[field];
  if (candidate === undefined) return [];
  if (!Array.isArray(candidate) ||
    !candidate.every((item): item is string => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return candidate;
}

export function parseBoundedQueryInteger(
  value: string,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseListPageQuery(url: URL): ListPageInput {
  const pageValue = url.searchParams.get("page");
  const pageSizeValue = url.searchParams.get("pageSize");
  const archive = url.searchParams.get("archive") ?? "current";
  if (archive !== "current" && archive !== "archived" && archive !== "all") {
    throw new Error("archive must be current, archived or all");
  }
  return {
    page: pageValue === null
      ? 1
      : parseBoundedQueryInteger(pageValue, "page", 1, 100_000),
    pageSize: pageSizeValue === null
      ? 20
      : parseBoundedQueryInteger(pageSizeValue, "pageSize", 1, 100),
    search: url.searchParams.get("q") ?? "",
    archive
  };
}

export function json(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(value)}\n`);
}
