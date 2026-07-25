import type { DatabaseSync } from "node:sqlite";

import type { DeviceSummary } from "../../protocol.js";
import { openRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./local-schema.js";

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

export class LocalDeviceStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = openRuntimeDatabase(databasePath);
    this.#migrate();
  }

  public close(): void {
    this.#database.close();
  }

  public current(): LocalDeviceMetadata | undefined {
    return undefined;
  }

  public beginPairing(serverUrl: string, deviceName: string): LocalDeviceMetadata {
    void serverUrl;
    void deviceName;
    throw deferredServerBinding();
  }

  public activate(
    credentialId: string,
    summary: DeviceSummary,
    timestamp: string
  ): LocalDeviceMetadata {
    void credentialId;
    void summary;
    void timestamp;
    throw deferredServerBinding();
  }

  public verify(summary: DeviceSummary, timestamp: string): LocalDeviceMetadata {
    void summary;
    void timestamp;
    throw deferredServerBinding();
  }

  public revoke(timestamp: string): void {
    void timestamp;
    throw deferredServerBinding();
  }

  #migrate(): void {
    migrateLocalDatabase(this.#database);
  }
}

function deferredServerBinding(): Error {
  return new Error("Server Device binding persistence is deferred to v0.4");
}
