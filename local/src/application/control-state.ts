import { createHash } from "node:crypto";

/** Optimistic control token derived from source-owned state; never persisted. */
export function controlStateToken(state: unknown): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
export function requireControlState(state: unknown, expectedState?: string): void {
  if (expectedState !== undefined && controlStateToken(state) !== expectedState) {
    throw new Error("Resource state changed; read it again before deciding");
  }
}
