import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ServerError } from "../modules/shared/error.js";

const SESSION_COOKIE = "rs_session";
const JSON_BODY_LIMIT = 64 * 1024;

export interface ApiRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
}

export async function readJsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new ServerError(
      "unsupported_media_type",
      415,
      "content-type must be application/json"
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > JSON_BODY_LIMIT) {
      throw new ServerError("request_too_large", 413, "request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ServerError("invalid_json", 400, "request body is not valid JSON");
  }
}

export function sessionToken(request: IncomingMessage): string | undefined {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === SESSION_COOKIE) {
      return decodeURIComponent(value.join("="));
    }
  }
  return undefined;
}

export function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=43200",
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

export function assertSameOrigin(request: IncomingMessage, publicUrl: string): void {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== new URL(publicUrl).origin) {
    throw new ServerError("origin_mismatch", 403, "request origin is not allowed");
  }
}

export function matchPath(pathname: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(pathname)?.[1];
  return value === undefined ? undefined : decodeURIComponent(value);
}

export function matchPath2(
  pathname: string,
  pattern: RegExp
): readonly [string, string] | undefined {
  const match = pattern.exec(pathname);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : [decodeURIComponent(match[1]), decodeURIComponent(match[2])];
}

export function matchPath3(
  pathname: string,
  pattern: RegExp
): readonly [string, string, string] | undefined {
  const match = pattern.exec(pathname);
  return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
    ? undefined
    : [
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
        decodeURIComponent(match[3])
      ];
}

export function requireQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === "") {
    throw new ServerError("invalid_request", 400, `${name} is required`);
  }
  return value;
}

export function assertBearerToken(
  request: IncomingMessage,
  expected: string | undefined
): void {
  const actual = bearerToken(request);
  if (expected === undefined || actual === undefined || !safeEqual(expected, actual)) {
    throw new ServerError("unauthorized", 401, "Matrix homeserver token is invalid");
  }
}

export function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
}

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(body)}\n`);
}

export function writeHtml(
  response: ServerResponse,
  status: number,
  body: string,
  options: { readonly scriptNonce?: string } = {}
): void {
  const scriptPolicy = options.scriptNonce === undefined
    ? ""
    : ` script-src 'nonce-${options.scriptNonce}';`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      `default-src 'none';${scriptPolicy} form-action 'self'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer);
}
