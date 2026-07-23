import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createVerifier(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomToken();
  return { verifier, challenge: sha256Base64Url(verifier) };
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashesEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer);
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function parseOpaqueCredential(
  value: string | undefined
): { readonly id: string; readonly secret: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) {
    return undefined;
  }
  return {
    id: value.slice(0, separator),
    secret: value.slice(separator + 1)
  };
}
