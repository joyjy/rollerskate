import { randomBytes } from "node:crypto";

export type LocalIdPrefix =
  | "dev"
  | "prn"
  | "top"
  | "sub"
  | "scb"
  | "pcb"
  | "sch"
  | "run";

export function localId(prefix: LocalIdPrefix): string {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((milliseconds >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function requireLocalId(value: string, prefix: LocalIdPrefix, field: string): string {
  if (!new RegExp(
    `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
  ).test(value)) {
    throw new Error(`${field} must be a ${prefix}_ UUIDv7`);
  }
  return value;
}
