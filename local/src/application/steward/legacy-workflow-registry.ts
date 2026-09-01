import { existsSync, readFileSync, statSync } from "node:fs";

import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { resolveSpecToken } from "../../modules/spec/registry.js";

const REGISTRY_SCHEMA = "LegacyTriggerWorkflowRegistry@1";
const MAX_REGISTRY_BYTES = 262_144;

export interface RegisteredLegacyTriggerWorkflow {
  readonly source: {
    readonly kind: "schedule" | "subscription" | "continuous_subscription";
    readonly id: string;
    readonly definitionRevision: string;
  };
  readonly callbackId: string;
  readonly workflowRef: string;
  readonly participantRef: string;
  readonly terminalResultPolicy: "retain" | "deliver";
  readonly resultDestinationRef?: string;
}

export function listRegisteredLegacyTriggerWorkflows(
  repoRoot: string,
  runtimeDirectory?: string
): readonly RegisteredLegacyTriggerWorkflow[] {
  const path = runtimePaths(repoRoot, runtimeDirectory).legacyTriggerWorkflows;
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) {
    throw new Error("Legacy trigger workflow registry must be a bounded regular file");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const registry = record(parsed, REGISTRY_SCHEMA);
  exactKeys(registry, ["schemaVersion", "mappings"], REGISTRY_SCHEMA);
  if (registry.schemaVersion !== REGISTRY_SCHEMA || !Array.isArray(registry.mappings)) {
    throw new Error(`${REGISTRY_SCHEMA} is required`);
  }
  if (registry.mappings.length > 64) {
    throw new Error("Legacy trigger workflow registry exceeds 64 mappings");
  }
  const mappings = registry.mappings.map(parseMapping);
  unique(mappings.map(mappingKey), "legacy trigger workflow mapping");
  return mappings.sort((left, right) => mappingKey(left).localeCompare(mappingKey(right)));
}

function parseMapping(value: unknown, index: number): RegisteredLegacyTriggerWorkflow {
  const label = `mappings[${index}]`;
  const mapping = record(value, label);
  exactKeys(mapping, [
    "source", "callbackId", "workflowRef", "participantRef", "terminalResultPolicy",
    "resultDestinationRef"
  ], label, ["resultDestinationRef"]);
  const source = record(mapping.source, `${label}.source`);
  exactKeys(source, ["kind", "id", "definitionRevision"], `${label}.source`);
  if (source.kind !== "schedule" && source.kind !== "subscription" &&
    source.kind !== "continuous_subscription") {
    throw new Error(`${label}.source.kind is unsupported`);
  }
  const workflowRef = text(mapping.workflowRef, `${label}.workflowRef`, 256);
  resolveSpecToken(workflowRef, { kind: "workflow" });
  const participantRef = text(mapping.participantRef, `${label}.participantRef`, 512);
  if (!participantRef.startsWith("principal:") ||
    participantRef.slice("principal:".length).trim() === "") {
    throw new Error(`${label}.participantRef must use principal:<id>`);
  }
  const terminalResultPolicy = mapping.terminalResultPolicy;
  if (terminalResultPolicy !== "retain" && terminalResultPolicy !== "deliver") {
    throw new Error(`${label}.terminalResultPolicy must be retain or deliver`);
  }
  const resultDestinationRef = mapping.resultDestinationRef === undefined
    ? undefined
    : text(mapping.resultDestinationRef, `${label}.resultDestinationRef`, 512);
  if (resultDestinationRef !== undefined &&
    !/^destination:dst_[0-9a-f-]+$/.test(resultDestinationRef)) {
    throw new Error(`${label}.resultDestinationRef must use destination:<dst-id>`);
  }
  if ((terminalResultPolicy === "deliver") !== (resultDestinationRef !== undefined)) {
    throw new Error(
      `${label}.resultDestinationRef is required only for terminalResultPolicy=deliver`
    );
  }
  return {
    source: {
      kind: source.kind,
      id: text(source.id, `${label}.source.id`, 512),
      definitionRevision: text(
        source.definitionRevision,
        `${label}.source.definitionRevision`,
        512
      )
    },
    callbackId: text(mapping.callbackId, `${label}.callbackId`, 256),
    workflowRef,
    participantRef,
    terminalResultPolicy,
    ...(resultDestinationRef === undefined ? {} : { resultDestinationRef })
  };
}

function mappingKey(mapping: RegisteredLegacyTriggerWorkflow): string {
  return [
    mapping.source.kind,
    mapping.source.id,
    mapping.source.definitionRevision,
    mapping.callbackId
  ].join("\0");
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
  optional: readonly string[] = []
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${field} has unknown field: ${unknown}`);
  const missing = allowed.find((key) => !optional.includes(key) && value[key] === undefined);
  if (missing !== undefined) throw new Error(`${field} is missing field: ${missing}`);
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}
