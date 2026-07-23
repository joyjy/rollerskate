import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";

import {
  DEFAULT_ROOM_CHAT_POLICY,
  type OwnerMessageWake,
  type RoomChatPolicy,
  type RoomWakeMode
} from "../integrations/matrix/room-contract.js";

export interface RoomPolicyUpdate {
  readonly ownerMessageWake?: OwnerMessageWake;
  readonly intervalMilliseconds?: number;
  readonly maxWakesPerHour?: number;
  readonly maxRepliesPerHour?: number;
  readonly maxInputTokensPerTurn?: number;
  readonly maxOutputTokensPerTurn?: number;
  readonly maxDailyTokens?: number;
}

interface StoredRoomPolicies {
  readonly schemaVersion: 1;
  readonly policies: Readonly<Record<string, RoomPolicyUpdate>>;
}

export class RoomPolicyStore {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public matrixPolicy(agentId: string, roomId: string, wakeMode: RoomWakeMode): RoomChatPolicy {
    return { ...DEFAULT_ROOM_CHAT_POLICY, ...this.#load().policies[key(agentId, roomId)], wakeMode };
  }

  public updateMatrixPolicy(
    agentId: string,
    roomId: string,
    update: RoomPolicyUpdate
  ): RoomPolicyUpdate {
    const current = this.#load();
    const merged = { ...current.policies[key(agentId, roomId)], ...update };
    validate(merged);
    this.#write({
      schemaVersion: 1,
      policies: { ...current.policies, [key(agentId, roomId)]: merged }
    });
    return merged;
  }

  #load(): StoredRoomPolicies {
    if (!existsSync(this.#path)) return { schemaVersion: 1, policies: {} };
    assertPrivateRegularFile(this.#path);
    const value = JSON.parse(readFileSync(this.#path, "utf8")) as StoredRoomPolicies;
    if (value.schemaVersion !== 1 || typeof value.policies !== "object" ||
      value.policies === null) {
      throw new Error("Room policy file has an unsupported schema");
    }
    for (const policy of Object.values(value.policies)) validate(policy);
    return value;
  }

  #write(value: StoredRoomPolicies): void {
    if (existsSync(this.#path) && lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("Room policy file must not be a symlink");
    }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

function validate(policy: RoomPolicyUpdate): void {
  if (policy.ownerMessageWake !== undefined &&
    !["never", "mention_only", "normal"].includes(policy.ownerMessageWake)) {
    throw new Error("owner message wake must be never, mention_only or normal");
  }
  for (const [name, value] of Object.entries(policy)) {
    if (name !== "ownerMessageWake" &&
      (!Number.isInteger(value) || (value as number) < 0)) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
}

function key(agentId: string, roomId: string): string {
  if (agentId.trim() === "" || roomId.trim() === "") {
    throw new Error("Room policy identifiers must be non-empty");
  }
  return `${agentId}\u0000${roomId}`;
}

function assertPrivateRegularFile(path: string): void {
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error("Room policy path must be a regular file");
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("Room policy file must not be accessible by group or others");
  }
}
