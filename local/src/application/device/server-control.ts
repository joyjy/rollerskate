import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";

import type { DeviceSummary } from "../../protocol.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../../infrastructure/sqlite/schema.js";
import { DeviceServerClient, DeviceServerError } from "../../integrations/server/device-client.js";
import { PairingServerClient } from "../../integrations/server/pairing-client.js";
import { DeviceCredentialStore } from "../../infrastructure/files/device-credential-store.js";
import { LocalDeviceStore, type LocalDeviceMetadata } from "../../infrastructure/files/device-binding-store.js";
import { bootstrapLocalFoundation } from "../../infrastructure/sqlite/foundation-store.js";

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

export interface DeviceLoginAuthorization {
  readonly verificationUri: string;
  readonly userCode?: string;
  readonly expiresAt: string;
  readonly completion: Promise<LocalDeviceStatus>;
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
    const login = await beginDeviceLoginWithResources(
      resources,
      configuredServerUrl,
      false,
      dependencies
    );
    dependencies.write?.(
      `Open this URL to approve the device:\n${login.verificationUri}\n` +
      (login.userCode === undefined ? "" : `Enter code: ${login.userCode}\n`) +
      "Waiting for approval...\n"
    );
    return await login.completion;
  } finally {
    resources.store.close();
  }
}

export async function startBrowserDeviceLogin(
  repoRoot: string,
  options: { readonly serverUrl: string; readonly replaceExisting?: boolean },
  dependencies: DeviceOperationDependencies = {}
): Promise<DeviceLoginAuthorization> {
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    return await beginDeviceLoginWithResources(
      resources,
      options.serverUrl,
      options.replaceExisting === true,
      dependencies,
      true,
      "authorization_code"
    );
  } catch (error) {
    resources.store.close();
    throw error;
  }
}

async function beginDeviceLoginWithResources(
  resources: ReturnType<typeof openResources>,
  configuredServerUrl: string,
  replaceExisting: boolean,
  dependencies: DeviceOperationDependencies,
  closeWhenComplete = false,
  flow: "device_code" | "authorization_code" = "device_code"
): Promise<DeviceLoginAuthorization> {
  const serverUrl = normalizeServerUrl(configuredServerUrl);
  const deviceName = hostname().trim();
  if (deviceName === "") throw new Error("device name must be non-empty");
  const metadata = resources.store.beginPairing(serverUrl, deviceName, { replaceExisting });
  const verifier = randomBytes(32).toString("base64url");
  const client = new PairingServerClient({
    serverUrl,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });
  const pairingRequest = {
    deviceId: metadata.deviceId,
    deviceName: metadata.deviceName,
    verifierChallenge: createHash("sha256").update(verifier).digest("base64url")
  };
  const pairing = await (flow === "authorization_code"
    ? client.createBrowserPairing(pairingRequest)
    : client.createPairing(pairingRequest));
  const completion = completeDeviceLogin(
    resources,
    client,
    pairing,
    verifier,
    serverUrl,
    dependencies
  ).finally(() => {
    if (closeWhenComplete) resources.store.close();
  });
  return {
    verificationUri: pairing.verificationUri,
    ...(pairing.userCode === undefined ? {} : { userCode: pairing.userCode }),
    expiresAt: pairing.expiresAt,
    completion
  };
}

async function completeDeviceLogin(
  resources: ReturnType<typeof openResources>,
  client: PairingServerClient,
  pairing: Awaited<ReturnType<PairingServerClient["createPairing"]>>,
  verifier: string,
  serverUrl: string,
  dependencies: DeviceOperationDependencies
): Promise<LocalDeviceStatus> {
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let pollIntervalMilliseconds = pairing.pollIntervalMilliseconds;
  while (currentTime(dependencies).getTime() < Date.parse(pairing.expiresAt)) {
    let status: Awaited<ReturnType<PairingServerClient["pairingStatus"]>>;
    try {
      status = await client.pairingStatus(pairing.pairingId);
    } catch (error) {
      if (!isTransientPairingError(error)) throw error;
      await sleep(pollIntervalMilliseconds);
      continue;
    }
    pollIntervalMilliseconds = status.pollIntervalMilliseconds ?? pollIntervalMilliseconds;
    if (status.status === "approved") {
      let issuance: Awaited<ReturnType<PairingServerClient["redeemPairing"]>>;
      try {
        issuance = await client.redeemPairing(
          pairing.pairingId,
          pairing.deviceId,
          verifier
        );
      } catch (error) {
        if (!isTransientPairingError(error)) throw error;
        await sleep(pollIntervalMilliseconds);
        continue;
      }
      resources.credentials.save({
        serverUrl,
        deviceId: pairing.deviceId,
        credentialId: issuance.credentialId,
        credential: issuance.credential
      });
      const timestamp = currentTimestamp(dependencies);
      return {
        metadata: resources.store.activate(
          issuance.credentialId,
          issuance.device,
          timestamp,
          { serverUrl }
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
}

function isTransientPairingError(error: unknown): boolean {
  if (error instanceof DeviceServerError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof TypeError) return true;
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
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
  const current = store.current();
  const timestamp = currentTimestamp(dependencies);
  return {
    metadata: current?.status === "active" &&
      current.credentialId === credential.credentialId
      ? store.verify(summary, timestamp)
      : store.activate(credential.credentialId, summary, timestamp, {
        serverUrl: credential.serverUrl
      }),
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
  const foundation = bootstrapLocalFoundation(paths);
  return {
    store: new LocalDeviceStore(paths.deviceBinding, {
      deviceId: foundation.deviceId,
      deviceName: foundation.deviceName
    }),
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
