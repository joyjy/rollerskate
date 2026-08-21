import type { IntegrationBindingRecord } from "./model.js";

export interface ConnectorRepository {
  createIntegrationBinding(binding: IntegrationBindingRecord): Promise<void>;
  getIntegrationBinding(bindingId: string): Promise<IntegrationBindingRecord | undefined>;
  updateIntegrationBinding(
    binding: IntegrationBindingRecord,
    expectedRevision: number
  ): Promise<IntegrationBindingRecord | undefined>;
}
