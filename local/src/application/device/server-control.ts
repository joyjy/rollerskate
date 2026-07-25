import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";

import type { DeviceSummary } from "../../protocol.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../../infrastructure/sqlite/schema.js";
import { DeviceServerClient, DeviceServerError } from "../../integrations/server/device-client.js";
import { DeviceCredentialStore } from "../../infrastructure/files/device-credential-store.js";
import { LocalDeviceStore, type LocalDeviceMetadata } from "../../infrastructure/sqlite/device-store.js";

export interface DeviceOperationDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly write?: (text: string) => void;
  readonly runtimeDirectory?: string;
}

export interface DeviceLoginOptions {
  readonly serverUrl?: string;
}

export interface LocalDeviceStatus {
  readonly metadata: LocalDeviceMetadata;
  readonly summary: DeviceSummary;
}

export async function loginDevice(
  repoRoot: string,
  options: DeviceLoginOptions,
  dependencies: DeviceOperationDependencies = {}
): Promise<LocalDeviceStatus> {
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    const existingCredential = resources.credentials.load();
    if (existingCredential !== undefined) {
      return verifyCredential(resources.store, existingCredential, dependencies);
    }
    const existingMetadata = resources.store.current();
    const configuredServerUrl = options.serverUrl?.trim() || existingMetadata?.serverUrl;
    if (configuredServerUrl === undefined) {
      throw new Error(
        "device login requires ROLLERSKATE_SERVER_URL or a server saved in this runtime"
      );
    }
    const serverUrl = normalizeServerUrl(configuredServerUrl);
    const deviceName = hostname().trim();
    if (deviceName === "") {
      throw new Error("device name must be non-empty");
    }
    const metadata = resources.store.beginPairing(serverUrl, deviceName);
    const verifier = randomBytes(32).toString("base64url");
    const client = new DeviceServerClient({
      serverUrl,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
    });
    const pairing = await client.createPairing({
      deviceId: metadata.deviceId,
      deviceName: metadata.deviceName,
      verifierChallenge: createHash("sha256").update(verifier).digest("base64url")
    });
    dependencies.write?.(
      `Open this URL to approve the device:\n${pairing.verificationUri}\n` +
      (pairing.userCode === undefined ? "" : `Enter code: ${pairing.userCode}\n`) +
      "Waiting for approval...\n"
    );
    const sleep = dependencies.sleep ?? ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let pollIntervalMilliseconds = pairing.pollIntervalMilliseconds;
    while (currentTime(dependencies).getTime() < Date.parse(pairing.expiresAt)) {
      const status = await client.pairingStatus(pairing.pairingId);
      pollIntervalMilliseconds = status.pollIntervalMilliseconds ?? pollIntervalMilliseconds;
      if (status.status === "approved") {
        const issuance = await client.redeemPairing(
          pairing.pairingId,
          metadata.deviceId,
          verifier
        );
        resources.credentials.save({
          serverUrl,
          deviceId: metadata.deviceId,
          credentialId: issuance.credentialId,
          credential: issuance.credential
        });
        const timestamp = currentTimestamp(dependencies);
        return {
          metadata: resources.store.activate(
            issuance.credentialId,
            issuance.device,
            timestamp
          ),
          summary: issuance.device
        };
      }
      if (["expired", "cancelled", "redeemed"].includes(status.status)) {
        throw new Error(`device pairing ended with status ${status.status}`);
      }
      await sleep(pollIntervalMilliseconds);
    }
    throw new Error("device pairing expired before approval");
  } finally {
    resources.store.close();
  }
}

export async function statusDevice(
  repoRoot: string,
  dependencies: DeviceOperationDependencies = {}
): Promise<LocalDeviceStatus> {
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    const credential = resources.credentials.load();
    if (credential === undefined) {
      throw new Error("this Local Runtime is not paired");
    }
    return await verifyCredential(resources.store, credential, dependencies);
  } finally {
    resources.store.close();
  }
}

export async function logoutDevice(
  repoRoot: string,
  dependencies: DeviceOperationDependencies = {}
): Promise<void> {
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    const credential = resources.credentials.load();
    if (credential === undefined) {
      throw new Error("this Local Runtime is not paired");
    }
    const client = authenticatedClient(credential, dependencies);
    try {
      await client.revoke();
    } catch (error) {
      if (!(error instanceof DeviceServerError && error.status === 401)) {
        throw error;
      }
    }
    resources.store.revoke(currentTimestamp(dependencies));
    resources.credentials.remove();
  } finally {
    resources.store.close();
  }
}

async function verifyCredential(
  store: LocalDeviceStore,
  credential: ReturnType<DeviceCredentialStore["load"]> & {},
  dependencies: DeviceOperationDependencies
): Promise<LocalDeviceStatus> {
  const summary = await authenticatedClient(credential, dependencies).status();
  if (summary.id !== credential.deviceId) {
    throw new Error("Server returned a different Device identity");
  }
  return {
    metadata: store.verify(summary, currentTimestamp(dependencies)),
    summary
  };
}

function authenticatedClient(
  credential: ReturnType<DeviceCredentialStore["load"]> & {},
  dependencies: DeviceOperationDependencies
): DeviceServerClient {
  return new DeviceServerClient({
    serverUrl: credential.serverUrl,
    credential: credential.credential,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });
}

function openResources(repoRoot: string, runtimeDirectory?: string): {
  readonly store: LocalDeviceStore;
  readonly credentials: DeviceCredentialStore;
} {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.runtimeDirectory, 0o700);
  initializeRuntimeSchema(paths.database);
  return {
    store: new LocalDeviceStore(paths.database),
    credentials: new DeviceCredentialStore(paths.deviceCredential)
  };
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Rollerskate Server URL must be an origin without a path");
  }
  return url.origin;
}

function currentTimestamp(dependencies: DeviceOperationDependencies): string {
  return currentTime(dependencies).toISOString();
}

function currentTime(dependencies: DeviceOperationDependencies): Date {
  return (dependencies.now ?? (() => new Date()))();
}
