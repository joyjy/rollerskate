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

import type { DeviceSummary } from "../../protocol.js";

export interface LocalDeviceMetadata {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly serverUrl: string;
  readonly credentialId?: string;
  readonly status: "pairing" | "active" | "revoked";
  readonly pairedAt?: string;
  readonly lastVerifiedAt?: string;
  readonly humanId?: string;
  readonly humanDisplayName?: string;
  readonly humanIsAdmin?: boolean;
}

interface StoredDeviceBinding extends LocalDeviceMetadata {
  readonly schemaVersion: 1;
}

export class LocalDeviceStore {
  readonly #path: string;
  readonly #deviceId: string;
  readonly #defaultDeviceName: string;

  public constructor(
    path: string,
    identity: { readonly deviceId: string; readonly deviceName: string }
  ) {
    this.#path = path;
    this.#deviceId = identity.deviceId;
    this.#defaultDeviceName = identity.deviceName;
  }

  public close(): void {}

  public current(): LocalDeviceMetadata | undefined {
    if (!existsSync(this.#path)) return undefined;
    assertRegularPrivateFile(this.#path);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `invalid Device binding file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isStoredDeviceBinding(value) || value.deviceId !== this.#deviceId) {
      throw new Error("Device binding file has an unsupported or mismatched identity");
    }
    const { schemaVersion: _schemaVersion, ...metadata } = value;
    return metadata;
  }

  public beginPairing(
    serverUrl: string,
    deviceName: string,
    options: { readonly replaceExisting?: boolean } = {}
  ): LocalDeviceMetadata {
    const existing = this.current();
    if (existing !== undefined && existing.status !== "revoked" &&
      options.replaceExisting !== true) {
      if (existing.serverUrl !== serverUrl) {
        throw new Error("this Local Runtime is already paired with a different Server");
      }
      return existing;
    }
    const metadata: LocalDeviceMetadata = {
      deviceId: this.#deviceId,
      deviceName: deviceName.trim() || this.#defaultDeviceName,
      serverUrl,
      status: "pairing"
    };
    if (existing?.status === "active" && options.replaceExisting === true) {
      return metadata;
    }
    this.#save(metadata);
    return metadata;
  }

  public activate(
    credentialId: string,
    summary: DeviceSummary,
    timestamp: string,
    options: { readonly serverUrl?: string } = {}
  ): LocalDeviceMetadata {
    const current = this.#requireCurrent();
    assertDeviceIdentity(current, summary);
    const metadata = summaryMetadata({
      ...current,
      ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl })
    }, summary, timestamp, {
      credentialId,
      pairedAt: current.pairedAt ?? timestamp
    });
    this.#save(metadata);
    return metadata;
  }

  public verify(summary: DeviceSummary, timestamp: string): LocalDeviceMetadata {
    const current = this.#requireCurrent();
    if (current.status !== "active" || current.credentialId === undefined) {
      throw new Error("Device binding is not active");
    }
    assertDeviceIdentity(current, summary);
    const metadata = summaryMetadata(current, summary, timestamp, {
      credentialId: current.credentialId,
      pairedAt: current.pairedAt ?? timestamp
    });
    this.#save(metadata);
    return metadata;
  }

  public revoke(timestamp: string): void {
    const current = this.#requireCurrent();
    this.#save({
      ...current,
      status: "revoked",
      lastVerifiedAt: timestamp
    });
  }

  #requireCurrent(): LocalDeviceMetadata {
    const current = this.current();
    if (current === undefined) throw new Error("Device binding is missing");
    return current;
  }

  #save(metadata: LocalDeviceMetadata): void {
    if (existsSync(this.#path) && lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("Device binding file must not be a symlink");
    }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: 1,
        ...metadata
      } satisfies StoredDeviceBinding, null, 2)}\n`, {
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

function summaryMetadata(
  current: LocalDeviceMetadata,
  summary: DeviceSummary,
  timestamp: string,
  binding: { readonly credentialId: string; readonly pairedAt: string }
): LocalDeviceMetadata {
  return {
    deviceId: current.deviceId,
    deviceName: summary.name,
    serverUrl: current.serverUrl,
    credentialId: binding.credentialId,
    status: summary.status === "active" ? "active" : "revoked",
    pairedAt: binding.pairedAt,
    lastVerifiedAt: timestamp,
    humanId: summary.human.id,
    humanDisplayName: summary.human.displayName,
    humanIsAdmin: summary.human.isAdmin
  };
}

function assertDeviceIdentity(current: LocalDeviceMetadata, summary: DeviceSummary): void {
  if (summary.id !== current.deviceId) {
    throw new Error("Server returned a different Device identity");
  }
}

function assertRegularPrivateFile(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("Device binding file must not be a symlink");
  }
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("Device binding file must be a private regular file");
  }
}

function isStoredDeviceBinding(value: unknown): value is StoredDeviceBinding {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !["pairing", "active", "revoked"].includes(String(value.status))) {
    return false;
  }
  for (const field of ["deviceId", "deviceName", "serverUrl"] as const) {
    if (typeof value[field] !== "string" || value[field] === "") return false;
  }
  for (const field of [
    "credentialId", "pairedAt", "lastVerifiedAt", "humanId", "humanDisplayName"
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  return value.humanIsAdmin === undefined || typeof value.humanIsAdmin === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
