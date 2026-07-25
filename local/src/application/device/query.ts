import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../../infrastructure/sqlite/schema.js";
import { DeviceCredentialStore } from "../../infrastructure/files/device-credential-store.js";
import {
  LocalDeviceStore,
  type LocalDeviceMetadata
} from "../../infrastructure/sqlite/device-store.js";

export interface LocalDeviceInspection {
  readonly hasCredential: boolean;
  readonly metadata?: LocalDeviceMetadata;
}

export function inspectLocalDevice(
  repoRoot: string,
  runtimeDirectory?: string
): LocalDeviceInspection {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  const store = new LocalDeviceStore(paths.database);
  const credentials = new DeviceCredentialStore(paths.deviceCredential);
  try {
    const metadata = store.current();
    return {
      hasCredential: credentials.load() !== undefined,
      ...(metadata === undefined ? {} : { metadata })
    };
  } finally {
    store.close();
  }
}
