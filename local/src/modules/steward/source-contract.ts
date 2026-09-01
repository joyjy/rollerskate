import {
  boundedContractValue,
  contractIso,
  contractRecord,
  contractStringList,
  contractText,
  exactContractKeys
} from "./contract-codec.js";
import { assertSpecCompatibility } from "../spec/registry.js";

export type RunSourceKind = "schedule" | "subscription" | "continuous_subscription";

export interface RunSourceBinding {
  readonly schemaVersion: "RunSourceBinding@1";
  readonly runId: string;
  readonly seriesKey: string;
  readonly source: {
    readonly kind: RunSourceKind;
    readonly id: string;
    readonly definitionRevision: string;
  };
  readonly authorityDigest: string;
  readonly occurrencePolicy: "one_shot" | "recurring";
  readonly cancellationPolicy: "pause_source" | "cancel_source";
  readonly reconcilePolicy: "source_owned";
}

export interface TriggerOccurrenceEnvelope {
  readonly schemaVersion: "TriggerOccurrenceEnvelope@1";
  readonly source: RunSourceBinding["source"];
  readonly occurrenceKey: string;
  readonly sourceRevision: string;
  readonly observedAt: string;
  readonly observation?: unknown;
  readonly artifactRef?: string;
  readonly freshnessEvidence: readonly string[];
  readonly binding: {
    readonly runId: string;
    readonly seriesKey: string;
    readonly authorityDigest: string;
  };
}

export function parseRunSourceBinding(value: unknown): RunSourceBinding {
  const input = contractRecord(value, "RunSourceBinding@1");
  assertSpecCompatibility("spec:rollerskate/run-source-binding@1", input.schemaVersion, {
    kind: "contract"
  });
  exactContractKeys(input, [
    "schemaVersion", "runId", "seriesKey", "source", "authorityDigest",
    "occurrencePolicy", "cancellationPolicy", "reconcilePolicy"
  ], "RunSourceBinding@1");
  if (input.schemaVersion !== "RunSourceBinding@1" ||
    (input.occurrencePolicy !== "one_shot" && input.occurrencePolicy !== "recurring") ||
    (input.cancellationPolicy !== "pause_source" &&
      input.cancellationPolicy !== "cancel_source") ||
    input.reconcilePolicy !== "source_owned") {
    throw new Error("RunSourceBinding@1 is unsupported");
  }
  return {
    schemaVersion: "RunSourceBinding@1",
    runId: contractText(input.runId, "runId", 256),
    seriesKey: contractText(input.seriesKey, "seriesKey", 512),
    source: sourceRef(input.source),
    authorityDigest: digest(input.authorityDigest, "authorityDigest"),
    occurrencePolicy: input.occurrencePolicy,
    cancellationPolicy: input.cancellationPolicy,
    reconcilePolicy: "source_owned"
  };
}

export function parseTriggerOccurrenceEnvelope(value: unknown): TriggerOccurrenceEnvelope {
  const input = contractRecord(value, "TriggerOccurrenceEnvelope@1");
  assertSpecCompatibility(
    "spec:rollerskate/trigger-occurrence-envelope@1",
    input.schemaVersion,
    { kind: "contract" }
  );
  exactContractKeys(input, [
    "schemaVersion", "source", "occurrenceKey", "sourceRevision", "observedAt",
    "observation", "artifactRef", "freshnessEvidence", "binding"
  ], "TriggerOccurrenceEnvelope@1", ["observation", "artifactRef"]);
  if (input.schemaVersion !== "TriggerOccurrenceEnvelope@1") {
    throw new Error("TriggerOccurrenceEnvelope@1 schemaVersion is required");
  }
  if ((input.observation === undefined) === (input.artifactRef === undefined)) {
    throw new Error("TriggerOccurrenceEnvelope@1 requires exactly one observation or artifactRef");
  }
  const binding = contractRecord(input.binding, "trigger binding receipt");
  exactContractKeys(binding, [
    "runId", "seriesKey", "authorityDigest"
  ], "trigger binding receipt");
  return {
    schemaVersion: "TriggerOccurrenceEnvelope@1",
    source: sourceRef(input.source),
    occurrenceKey: contractText(input.occurrenceKey, "occurrenceKey", 512),
    sourceRevision: contractText(input.sourceRevision, "sourceRevision", 512),
    observedAt: contractIso(input.observedAt, "observedAt"),
    ...(input.observation === undefined
      ? {}
      : { observation: boundedContractValue(input.observation, "observation") }),
    ...(input.artifactRef === undefined
      ? {}
      : { artifactRef: contractText(input.artifactRef, "artifactRef", 2_048) }),
    freshnessEvidence: contractStringList(
      input.freshnessEvidence,
      "freshnessEvidence",
      { minimum: 1 }
    ),
    binding: {
      runId: contractText(binding.runId, "binding.runId", 256),
      seriesKey: contractText(binding.seriesKey, "binding.seriesKey", 512),
      authorityDigest: digest(binding.authorityDigest, "binding.authorityDigest")
    }
  };
}

function sourceRef(value: unknown): RunSourceBinding["source"] {
  const source = contractRecord(value, "source");
  exactContractKeys(source, ["kind", "id", "definitionRevision"], "source");
  if (source.kind !== "schedule" && source.kind !== "subscription" &&
    source.kind !== "continuous_subscription") {
    throw new Error("source.kind is unsupported");
  }
  return {
    kind: source.kind,
    id: contractText(source.id, "source.id", 512),
    definitionRevision: contractText(
      source.definitionRevision,
      "source.definitionRevision",
      512
    )
  };
}

function digest(value: unknown, field: string): string {
  const result = contractText(value, field, 80);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${field} must be sha256:<hex>`);
  return result;
}
