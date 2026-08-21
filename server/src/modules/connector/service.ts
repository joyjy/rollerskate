import { randomUUID } from "node:crypto";

import type {
  IntegrationBinding,
  IntegrationBindingCreateRequest,
  IntegrationBindingUpdateRequest
} from "@rollerskate/protocol";

import type { DeviceAuthenticationRecord } from "../device/model.js";
import { ServerError } from "../shared/error.js";
import { now, type ClockOptions } from "../shared/time.js";
import type { ConnectorRepository } from "./repository.js";

export class ConnectorService {
  readonly #connectors: ConnectorRepository;
  readonly #clock: ClockOptions;

  public constructor(connectors: ConnectorRepository, clock: ClockOptions = {}) {
    this.#connectors = connectors;
    this.#clock = clock;
  }

  public async createIntegrationBinding(
    authentication: DeviceAuthenticationRecord,
    input: IntegrationBindingCreateRequest
  ): Promise<IntegrationBinding> {
    requireUnique(input.profileIds, "profileIds");
    const timestamp = now(this.#clock);
    const binding: IntegrationBinding = {
      schemaVersion: "IntegrationBinding@1",
      bindingId: randomUUID(),
      ownerHumanId: authentication.human.id,
      ...input,
      status: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.#connectors.createIntegrationBinding(binding);
    return binding;
  }

  public async getIntegrationBinding(
    authentication: DeviceAuthenticationRecord,
    bindingId: string
  ): Promise<IntegrationBinding> {
    const binding = await this.#connectors.getIntegrationBinding(bindingId);
    if (binding === undefined || binding.ownerHumanId !== authentication.human.id) {
      throw new ServerError(
        "integration_binding_not_found",
        404,
        "Integration binding not found"
      );
    }
    return binding;
  }

  public async updateIntegrationBinding(
    authentication: DeviceAuthenticationRecord,
    bindingId: string,
    input: IntegrationBindingUpdateRequest
  ): Promise<IntegrationBinding> {
    const current = await this.getIntegrationBinding(authentication, bindingId);
    const updated: IntegrationBinding = {
      ...current,
      ...(input.cursor === undefined
        ? {}
        : input.cursor === null ? { cursor: undefined } : { cursor: input.cursor }),
      ...(input.status === undefined ? {} : { status: input.status }),
      revision: input.expectedRevision + 1,
      updatedAt: now(this.#clock)
    };
    const stored = await this.#connectors.updateIntegrationBinding(
      updated,
      input.expectedRevision
    );
    if (stored === undefined) {
      throw new ServerError(
        "integration_revision_conflict",
        409,
        "Integration binding revision changed"
      );
    }
    return stored;
  }
}

function requireUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new ServerError("invalid_request", 400, `${field} must contain unique values`);
  }
}
