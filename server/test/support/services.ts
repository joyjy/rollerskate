import { TrustService } from "../../src/modules/trust/service.js";
import { AgentService } from "../../src/modules/agent/service.js";
import { DeviceService } from "../../src/modules/device/service.js";
import { DeviceLoginService } from "../../src/application/device/login-service.js";
import type { ServerRepository } from "../../src/application/repository.js";
import type { DeviceOidcProvider } from "../../src/modules/trust/oidc.js";
import { credentialService } from "../../src/adapter/security/credentials.js";

export interface TestServiceOptions {
  readonly issuer: string;
  readonly publicUrl: string;
  readonly now?: () => Date;
}

export interface TestServices {
  readonly trust: TrustService;
  readonly devices: DeviceService;
  readonly deviceLogin: DeviceLoginService;
  readonly agents: AgentService;
}

export function createTestServices(
  repository: ServerRepository,
  options: TestServiceOptions,
  deviceOidc: DeviceOidcProvider = unsupportedDeviceOidc
): TestServices {
  const trust = new TrustService(repository, options);
  return {
    trust,
    devices: new DeviceService(repository, { ...options, credentials: credentialService }),
    deviceLogin: new DeviceLoginService(repository, trust, deviceOidc, options),
    agents: new AgentService(repository, { ...options, credentials: credentialService })
  };
}

const unsupportedDeviceOidc: DeviceOidcProvider = {
  beginDeviceAuthorization: async () => {
    throw new Error("device OIDC is not configured for this test");
  },
  pollDeviceAuthorization: async () => {
    throw new Error("device OIDC is not configured for this test");
  }
};
