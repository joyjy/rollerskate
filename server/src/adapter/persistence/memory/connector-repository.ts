import type { IntegrationBindingRecord } from
  "../../../modules/connector/model.js";
import type { ConnectorRepository } from
  "../../../modules/connector/repository.js";

export class MemoryConnectorRepository implements ConnectorRepository {
  readonly #integrations = new Map<string, IntegrationBindingRecord>();

  public async createIntegrationBinding(binding: IntegrationBindingRecord): Promise<void> {
    this.#integrations.set(binding.bindingId, binding);
  }

  public async getIntegrationBinding(
    bindingId: string
  ): Promise<IntegrationBindingRecord | undefined> {
    return this.#integrations.get(bindingId);
  }

  public async updateIntegrationBinding(
    binding: IntegrationBindingRecord,
    expectedRevision: number
  ): Promise<IntegrationBindingRecord | undefined> {
    const current = this.#integrations.get(binding.bindingId);
    if (current?.revision !== expectedRevision) return undefined;
    this.#integrations.set(binding.bindingId, binding);
    return binding;
  }
}
