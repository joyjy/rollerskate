import {
  integrationBindingCreateRequestSchema,
  integrationBindingUpdateRequestSchema
} from "@rollerskate/protocol";

import type { DeviceService } from "../modules/device/service.js";
import type { ConnectorService } from "../modules/connector/service.js";
import { ServerError } from "../modules/shared/error.js";
import type { ApiRequest } from "./http.js";
import { bearerToken, matchPath, readJsonBody, writeJson } from "./http.js";

export interface ConnectorApiDependencies {
  readonly connectors?: ConnectorService;
  readonly devices: DeviceService;
}

export async function handleConnectorApi(
  context: ApiRequest,
  dependencies: ConnectorApiDependencies
): Promise<boolean> {
  const { request, response, url } = context;
  const connectors = (): ConnectorService => {
    if (dependencies.connectors === undefined) {
      throw new ServerError(
        "connectors_not_configured",
        503,
        "Connector service is not configured"
      );
    }
    return dependencies.connectors;
  };
  const authentication = async () =>
    dependencies.devices.authenticateDevice(bearerToken(request));

  if (url.pathname === "/api/integration-bindings" && request.method === "POST") {
    const body = integrationBindingCreateRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await connectors().createIntegrationBinding(
      await authentication(),
      body
    ));
    return true;
  }
  const bindingId = matchPath(url.pathname, /^\/api\/integration-bindings\/([^/]+)$/);
  if (bindingId !== undefined && request.method === "GET") {
    writeJson(response, 200, await connectors().getIntegrationBinding(
      await authentication(),
      bindingId
    ));
    return true;
  }
  if (bindingId !== undefined && request.method === "PATCH") {
    const body = integrationBindingUpdateRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 200, await connectors().updateIntegrationBinding(
      await authentication(),
      bindingId,
      body
    ));
    return true;
  }
  return false;
}
