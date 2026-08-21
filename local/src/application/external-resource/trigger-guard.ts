import {
  connectorReadResultSchema,
  type ConnectorReadRequest,
  type ConnectorReadResult
} from "@rollerskate/protocol";

import { DeviceServerClient } from "../../integrations/server/device-client.js";
import {
  EXTERNAL_REF_TRIGGER_MAX_BYTES,
  type ExternalRefTriggerBinding,
  type ExternalRefTriggerCheck,
  type ExternalRefTriggerGuard
} from "../../modules/external-resource/trigger-binding.js";

export interface ServerExternalRefTriggerGuardOptions {
  readonly client: Pick<DeviceServerClient, "integrationBinding">;
  readonly connectorRead: (request: ConnectorReadRequest) => Promise<ConnectorReadResult>;
}

export function serverExternalRefTriggerGuard(
  options: ServerExternalRefTriggerGuardOptions
): ExternalRefTriggerGuard {
  return async (binding) => recheckExternalRefTrigger(binding, options);
}

export async function recheckExternalRefTrigger(
  binding: ExternalRefTriggerBinding,
  options: ServerExternalRefTriggerGuardOptions
): Promise<ExternalRefTriggerCheck> {
  const integration = await options.client.integrationBinding(
    binding.integrationBinding.bindingId
  );
  if (integration.status !== "active") return rejected("integration-binding-inactive");
  if (integration.revision !== binding.integrationBinding.revision) {
    return rejected("integration-binding-revision-stale");
  }
  if (binding.ref.integrationBindingId !== integration.bindingId) {
    return rejected("binding-authority-mismatch");
  }
  if (integration.placement !== "runtime") return rejected("connector-placement-mismatch");
  if (!integration.profileIds.includes(binding.profileId)) {
    return rejected("connector-profile-not-authorized");
  }
  const read = connectorReadResultSchema.parse(await options.connectorRead({
    schemaVersion: "ConnectorReadRequest@1",
    ref: binding.ref,
    profileId: binding.profileId,
    schemaRef: binding.schemaRef,
    maxBytes: EXTERNAL_REF_TRIGGER_MAX_BYTES
  }));
  if (read.profileId !== binding.profileId || read.schemaRef !== binding.schemaRef ||
    read.ref.integrationBindingId !== binding.ref.integrationBindingId ||
    read.ref.kind !== binding.ref.kind || read.ref.externalId !== binding.ref.externalId) {
    return rejected("connector-read-authority-mismatch");
  }
  if (read.ref.revision !== binding.ref.revision) {
    return rejected("external-ref-revision-stale");
  }
  return { status: "matched", read };
}

function rejected(reason: string): ExternalRefTriggerCheck {
  return { status: "rejected", reason };
}
