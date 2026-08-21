import {
  connectorReadRequestSchema,
  externalRefSchema,
  type ConnectorReadResult,
  type ExternalRef
} from "@rollerskate/protocol";

export const EXTERNAL_REF_TRIGGER_MAX_BYTES = 16_384;

export interface ExternalRefTriggerBinding {
  readonly schemaVersion: "ExternalRefTriggerBinding@2";
  readonly integrationBinding: {
    readonly bindingId: string;
    readonly revision: number;
  };
  readonly ref: ExternalRef & { readonly revision: string };
  readonly profileId: string;
  readonly schemaRef: string;
}

export type ExternalRefTriggerCheck =
  | { readonly status: "matched"; readonly read: ConnectorReadResult }
  | { readonly status: "rejected"; readonly reason: string };

export type ExternalRefTriggerGuard = (
  binding: ExternalRefTriggerBinding
) => Promise<ExternalRefTriggerCheck>;

export function parseExternalRefTriggerBinding(
  input: unknown,
  field = "externalRefBinding"
): ExternalRefTriggerBinding {
  const value = record(input, field);
  exactKeys(value, [
    "schemaVersion", "integrationBinding", "ref", "profileId", "schemaRef"
  ], field);
  if (value.schemaVersion !== "ExternalRefTriggerBinding@2") {
    throw new Error(`${field}.schemaVersion is unsupported`);
  }
  const integration = record(value.integrationBinding, `${field}.integrationBinding`);
  exactKeys(integration, ["bindingId", "revision"], `${field}.integrationBinding`);
  const ref = externalRefSchema.parse(value.ref);
  const integrationBindingId = text(
    integration.bindingId,
    `${field}.integrationBinding.bindingId`,
    256
  );
  if (ref.integrationBindingId !== integrationBindingId) {
    throw new Error(`${field}.ref must belong to the fixed Integration binding`);
  }
  if (ref.revision === undefined) {
    throw new Error(`${field}.ref.revision is required`);
  }
  const readContract = connectorReadRequestSchema.parse({
    schemaVersion: "ConnectorReadRequest@1",
    ref,
    profileId: value.profileId,
    schemaRef: value.schemaRef,
    maxBytes: EXTERNAL_REF_TRIGGER_MAX_BYTES
  });
  return {
    schemaVersion: "ExternalRefTriggerBinding@2",
    integrationBinding: {
      bindingId: integrationBindingId,
      revision: positiveInteger(integration.revision, `${field}.integrationBinding.revision`)
    },
    ref: { ...ref, revision: ref.revision },
    profileId: readContract.profileId,
    schemaRef: readContract.schemaRef
  };
}

export function encodeExternalRefTriggerBinding(
  binding: ExternalRefTriggerBinding | undefined
): string | null {
  return binding === undefined
    ? null
    : JSON.stringify(parseExternalRefTriggerBinding(binding));
}

export function decodeExternalRefTriggerBinding(
  encoded: string | null,
  field = "externalRefBinding"
): ExternalRefTriggerBinding | undefined {
  if (encoded === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  return parseExternalRefTriggerBinding(value, field);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} has unknown field: ${unknown[0]}`);
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}
