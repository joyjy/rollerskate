import { parseAcceptanceContract, type AcceptanceContract } from "./acceptance.js";
import { parseStewardSelection, type StewardSelection } from "./steward-policy.js";
import { createHash } from "node:crypto";

import { assertSpecCompatibility } from "../spec/registry.js";
import {
  boundedContractValue,
  contractInteger,
  contractIso,
  contractRecord,
  contractStringList,
  contractText,
  exactContractKeys,
  stableContractJson
} from "./contract-codec.js";

export type RunDesiredEffect = "none" | "read" | "change";
export type RunTriggerIntent = "once" | "cron" | "until" | "continuous";

export interface RunIntent {
  readonly schemaVersion: "RunIntent@1";
  readonly requestId: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly contextRefs: readonly string[];
  readonly workspaceRef?: string;
  readonly desiredEffect?: RunDesiredEffect;
  readonly triggerIntent?: RunTriggerIntent;
  readonly resultDestinationRef?: string;
  readonly requestedParticipantRefs?: readonly string[];
  readonly terminalEvidence: readonly string[];
  readonly dispatchNotes?: string;
}

export interface RunAuthorityEnvelope {
  readonly schemaVersion: "RunAuthorityEnvelope@1";
  readonly workflowRef?: string;
  readonly participantAgentIds: readonly string[];
  readonly workspace?: {
    readonly root: string;
    readonly revision: string;
    readonly access: "read" | "write";
    readonly effect?: "must_change" | "may_remain_unchanged";
    readonly networkAccess: boolean;
  };
  readonly trigger?: {
    readonly allowedKinds: readonly RunTriggerIntent[];
    readonly minimumIntervalMilliseconds?: number;
    readonly maximumIntervalMilliseconds?: number;
    readonly deadlineAt?: string;
    readonly pluginRefs: readonly string[];
    readonly pluginPolicyDigests?: Readonly<Record<string, string>>;
    readonly allowedHttpOrigins: readonly string[];
    readonly allowedExecutables: readonly string[];
  };
  readonly destinationIds: readonly string[];
  readonly maxSteps: number;
  readonly maxDepth: number;
  readonly deadlineAt?: string;
}

export type CompiledRunMandate =
  | { readonly kind: "objective"; readonly objective: string }
  | {
      readonly kind: "workflow";
      readonly workflowRef: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    };

export interface StewardRunRequest {
  readonly acceptanceContract?: AcceptanceContract;
  readonly dispatchNotes?: string;
  readonly ownerNetworkAuthorized?: boolean;
  readonly schemaVersion: "StewardRunRequest@2";
  readonly stewardSelection?: StewardSelection;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly intentDigest: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly contextRefs: readonly string[];
  readonly terminalEvidence: readonly string[];
  readonly mandate: CompiledRunMandate;
  readonly authority: RunAuthorityEnvelope;
  readonly resultDestination?: {
    readonly schemaVersion: "RunResultDestination@2";
    readonly destinationId: string;
    readonly delivery: {
      readonly kind: string;
      readonly address: Readonly<Record<string, string>>;
    };
  };
  readonly admissionDigest: string;
  readonly authoritySummary: string;
}

export function parseRunIntent(value: unknown): RunIntent {
  const input = contractRecord(value, "RunIntent@1");
  assertSpecCompatibility("spec:rollerskate/run-intent@1", input.schemaVersion, {
    kind: "contract"
  });
  exactContractKeys(input, [
    "schemaVersion", "requestId", "objective", "acceptance", "contextRefs",
    "workspaceRef", "desiredEffect", "triggerIntent", "resultDestinationRef",
    "requestedParticipantRefs", "terminalEvidence", "dispatchNotes"
  ], "RunIntent@1", [
    "workspaceRef", "desiredEffect", "triggerIntent", "resultDestinationRef",
    "requestedParticipantRefs", "dispatchNotes"
  ]);
  if (input.schemaVersion !== "RunIntent@1") {
    throw new Error("RunIntent@1 schemaVersion is required");
  }
  const desiredEffect = input.desiredEffect;
  if (desiredEffect !== undefined && desiredEffect !== "none" &&
    desiredEffect !== "read" && desiredEffect !== "change") {
    throw new Error("RunIntent@1 desiredEffect is unsupported");
  }
  const triggerIntent = input.triggerIntent;
  if (triggerIntent !== undefined && triggerIntent !== "once" &&
    triggerIntent !== "cron" && triggerIntent !== "until" &&
    triggerIntent !== "continuous") {
    throw new Error("RunIntent@1 triggerIntent is unsupported");
  }
  return {
    schemaVersion: "RunIntent@1",
    ...(input.dispatchNotes === undefined ? {} : {dispatchNotes: contractText(input.dispatchNotes, "dispatchNotes")}),
    requestId: contractText(input.requestId, "requestId", 256),
    objective: contractText(input.objective, "objective"),
    acceptance: contractStringList(input.acceptance, "acceptance", { minimum: 1 }),
    contextRefs: contractStringList(input.contextRefs, "contextRefs"),
    ...(input.workspaceRef === undefined
      ? {}
      : { workspaceRef: contractText(input.workspaceRef, "workspaceRef", 512) }),
    ...(desiredEffect === undefined ? {} : { desiredEffect }),
    ...(triggerIntent === undefined ? {} : { triggerIntent }),
    ...(input.resultDestinationRef === undefined
      ? {}
      : {
          resultDestinationRef: contractText(
            input.resultDestinationRef,
            "resultDestinationRef",
            512
          )
        }),
    ...(input.requestedParticipantRefs === undefined
      ? {}
      : {
          requestedParticipantRefs: contractStringList(
            input.requestedParticipantRefs,
            "requestedParticipantRefs",
            { minimum: 1, maximum: 64 }
          )
        }),
    terminalEvidence: contractStringList(
      input.terminalEvidence,
      "terminalEvidence",
      { minimum: 1 }
    )
  };
}

export function runIntentDigest(intent: RunIntent): string {
  const parsed = parseRunIntent(intent);
  return `sha256:${createHash("sha256").update(stableContractJson(parsed)).digest("hex")}`;
}

export function runAuthorityDigest(authority: RunAuthorityEnvelope): string {
  const parsed = parseRunAuthorityEnvelope(authority);
  return `sha256:${createHash("sha256").update(stableContractJson(parsed)).digest("hex")}`;
}

export function parseRunAuthorityEnvelope(value: unknown): RunAuthorityEnvelope {
  const input = contractRecord(value, "RunAuthorityEnvelope@1");
  assertSpecCompatibility(
    "spec:rollerskate/run-authority-envelope@1",
    input.schemaVersion,
    { kind: "contract" }
  );
  exactContractKeys(input, [
    "schemaVersion", "workflowRef", "participantAgentIds", "workspace", "trigger",
    "destinationIds", "maxSteps", "maxDepth", "deadlineAt"
  ], "RunAuthorityEnvelope@1", ["workflowRef", "workspace", "trigger", "deadlineAt"]);
  if (input.schemaVersion !== "RunAuthorityEnvelope@1") {
    throw new Error("RunAuthorityEnvelope@1 schemaVersion is required");
  }
  return {
    schemaVersion: "RunAuthorityEnvelope@1",
    ...(input.workflowRef === undefined
      ? {}
      : { workflowRef: contractText(input.workflowRef, "workflowRef", 256) }),
    participantAgentIds: uniqueStrings(input.participantAgentIds, "participantAgentIds", 1, 64),
    ...(input.workspace === undefined ? {} : { workspace: workspaceAuthority(input.workspace) }),
    ...(input.trigger === undefined ? {} : { trigger: triggerAuthority(input.trigger) }),
    destinationIds: uniqueStrings(input.destinationIds, "destinationIds", 0, 64),
    maxSteps: contractInteger(input.maxSteps, "maxSteps", 1, 1_000),
    maxDepth: contractInteger(input.maxDepth, "maxDepth", 0, 100),
    ...(input.deadlineAt === undefined
      ? {}
      : { deadlineAt: contractIso(input.deadlineAt, "deadlineAt") })
  };
}

export function parseStewardRunRequest(value: unknown): StewardRunRequest {
  const input = contractRecord(value, "StewardRunRequest@2");
  if (input.ownerNetworkAuthorized !== undefined && typeof input.ownerNetworkAuthorized !== "boolean") throw new Error("ownerNetworkAuthorized must be boolean");
  assertSpecCompatibility(
    "spec:rollerskate/steward-run-request@2",
    input.schemaVersion,
    { kind: "contract" }
  );
  exactContractKeys(input, [
    "schemaVersion", "requestId", "idempotencyKey", "intentDigest", "objective",
    "acceptance", "contextRefs", "terminalEvidence", "mandate", "authority",
    "resultDestination", "admissionDigest", "authoritySummary", "stewardSelection", "acceptanceContract", "dispatchNotes", "ownerNetworkAuthorized"
  ], "StewardRunRequest@2", ["resultDestination", "stewardSelection", "acceptanceContract", "dispatchNotes", "ownerNetworkAuthorized"]);
  if (input.schemaVersion !== "StewardRunRequest@2") {
    throw new Error("StewardRunRequest@2 schemaVersion is required");
  }
  return {
    schemaVersion: "StewardRunRequest@2",
    ...(input.acceptanceContract === undefined ? {} : {acceptanceContract: parseAcceptanceContract(input.acceptanceContract)}),
    ...(input.dispatchNotes === undefined ? {} : {dispatchNotes: contractText(input.dispatchNotes, "dispatchNotes")}),
    ...(input.ownerNetworkAuthorized === true ? {ownerNetworkAuthorized: true} : {}),
    ...(input.stewardSelection === undefined ? {} : { stewardSelection: parseStewardSelection(input.stewardSelection) }),
    requestId: contractText(input.requestId, "requestId", 256),
    idempotencyKey: contractText(input.idempotencyKey, "idempotencyKey", 512),
    intentDigest: digest(input.intentDigest, "intentDigest"),
    objective: contractText(input.objective, "objective"),
    acceptance: contractStringList(input.acceptance, "acceptance", { minimum: 1 }),
    contextRefs: contractStringList(input.contextRefs, "contextRefs"),
    terminalEvidence: contractStringList(
      input.terminalEvidence,
      "terminalEvidence",
      { minimum: 1 }
    ),
    mandate: compiledMandate(input.mandate),
    authority: parseRunAuthorityEnvelope(input.authority),
    ...(input.resultDestination === undefined
      ? {}
      : { resultDestination: runResultDestination(input.resultDestination) }),
    admissionDigest: digest(input.admissionDigest, "admissionDigest"),
    authoritySummary: contractText(input.authoritySummary, "authoritySummary", 4_096)
  };
}

function runResultDestination(
  value: unknown
): NonNullable<StewardRunRequest["resultDestination"]> {
  const destination = contractRecord(value, "resultDestination");
  exactContractKeys(destination, [
    "schemaVersion", "destinationId", "delivery"
  ], "resultDestination");
  if (destination.schemaVersion !== "RunResultDestination@2") {
    throw new Error("RunResultDestination@2 is unsupported");
  }
  const delivery = contractRecord(destination.delivery, "resultDestination.delivery");
  exactContractKeys(delivery, ["kind", "address"], "resultDestination.delivery");
  const address = contractRecord(delivery.address, "resultDestination.delivery.address");
  const entries = Object.entries(address);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error("resultDestination.delivery.address must contain 1-16 entries");
  }
  return {
    schemaVersion: "RunResultDestination@2",
    destinationId: contractText(destination.destinationId, "resultDestination.destinationId", 256),
    delivery: {
      kind: contractText(delivery.kind, "resultDestination.delivery.kind", 128),
      address: Object.fromEntries(entries.map(([key, nested]) => [
        contractText(key, "resultDestination.delivery.address key", 128),
        contractText(nested, `resultDestination.delivery.address.${key}`, 2_048)
      ]))
    }
  };
}

function compiledMandate(value: unknown): CompiledRunMandate {
  const mandate = contractRecord(value, "mandate");
  if (mandate.kind === "objective") {
    exactContractKeys(mandate, ["kind", "objective"], "mandate");
    return { kind: "objective", objective: contractText(mandate.objective, "mandate.objective") };
  }
  exactContractKeys(mandate, ["kind", "workflowRef", "inputs"], "mandate");
  if (mandate.kind !== "workflow") throw new Error("mandate.kind is unsupported");
  return {
    kind: "workflow",
    workflowRef: contractText(mandate.workflowRef, "mandate.workflowRef", 256),
    inputs: contractRecord(boundedContractValue(mandate.inputs, "mandate.inputs"), "mandate.inputs")
  };
}

function workspaceAuthority(value: unknown): NonNullable<RunAuthorityEnvelope["workspace"]> {
  const workspace = contractRecord(value, "workspace authority");
  exactContractKeys(workspace, [
    "root", "revision", "access", "effect", "networkAccess"
  ], "workspace authority", ["effect"]);
  if (workspace.access !== "read" && workspace.access !== "write") {
    throw new Error("workspace authority access is unsupported");
  }
  if (typeof workspace.networkAccess !== "boolean") {
    throw new Error("workspace authority networkAccess must be boolean");
  }
  if (workspace.access === "read" && workspace.effect !== undefined) {
    throw new Error("read workspace authority cannot declare effect");
  }
  if (workspace.access === "write" && workspace.effect !== "must_change" &&
    workspace.effect !== "may_remain_unchanged") {
    throw new Error("write workspace authority requires effect");
  }
  const effect = workspace.effect as "must_change" | "may_remain_unchanged" | undefined;
  return {
    root: contractText(workspace.root, "workspace.root", 4_096),
    revision: contractText(workspace.revision, "workspace.revision", 512),
    access: workspace.access,
    ...(effect === undefined ? {} : { effect }),
    networkAccess: workspace.networkAccess
  };
}

function triggerAuthority(value: unknown): NonNullable<RunAuthorityEnvelope["trigger"]> {
  const trigger = contractRecord(value, "trigger authority");
  exactContractKeys(trigger, [
    "allowedKinds", "minimumIntervalMilliseconds", "maximumIntervalMilliseconds",
    "deadlineAt", "pluginRefs", "pluginPolicyDigests", "allowedHttpOrigins",
    "allowedExecutables"
  ], "trigger authority", [
    "minimumIntervalMilliseconds", "maximumIntervalMilliseconds", "deadlineAt",
    "pluginPolicyDigests"
  ]);
  const allowedKinds = uniqueStrings(trigger.allowedKinds, "allowedKinds", 1, 4)
    .map((kind) => {
      if (kind !== "once" && kind !== "cron" && kind !== "until" && kind !== "continuous") {
        throw new Error("trigger authority allowedKinds is unsupported");
      }
      return kind;
    });
  const minimum = trigger.minimumIntervalMilliseconds === undefined
    ? undefined
    : contractInteger(trigger.minimumIntervalMilliseconds, "minimumIntervalMilliseconds", 100, 31_536_000_000);
  const maximum = trigger.maximumIntervalMilliseconds === undefined
    ? undefined
    : contractInteger(trigger.maximumIntervalMilliseconds, "maximumIntervalMilliseconds", 100, 31_536_000_000);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new Error("trigger authority minimum interval exceeds maximum interval");
  }
  const pluginRefs = uniqueStrings(trigger.pluginRefs, "pluginRefs", 0, 64);
  const pluginPolicyDigests = trigger.pluginPolicyDigests === undefined
    ? undefined
    : digestMap(trigger.pluginPolicyDigests, pluginRefs);
  return {
    allowedKinds,
    ...(minimum === undefined ? {} : { minimumIntervalMilliseconds: minimum }),
    ...(maximum === undefined ? {} : { maximumIntervalMilliseconds: maximum }),
    ...(trigger.deadlineAt === undefined
      ? {}
      : { deadlineAt: contractIso(trigger.deadlineAt, "trigger.deadlineAt") }),
    pluginRefs,
    ...(pluginPolicyDigests === undefined ? {} : { pluginPolicyDigests }),
    allowedHttpOrigins: uniqueStrings(trigger.allowedHttpOrigins, "allowedHttpOrigins", 0, 64),
    allowedExecutables: uniqueStrings(trigger.allowedExecutables, "allowedExecutables", 0, 64)
  };
}

function digestMap(
  value: unknown,
  pluginRefs: readonly string[]
): Readonly<Record<string, string>> {
  const input = contractRecord(value, "pluginPolicyDigests");
  const entries = Object.entries(input);
  if (entries.length !== pluginRefs.length ||
    entries.some(([ref]) => !pluginRefs.includes(ref))) {
    throw new Error("pluginPolicyDigests must cover exactly pluginRefs");
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, value]) => [
      contractText(ref, "pluginPolicyDigests ref", 256),
      digest(value, `pluginPolicyDigests.${ref}`)
    ]));
}

function uniqueStrings(value: unknown, field: string, minimum: number, maximum: number): readonly string[] {
  const list = contractStringList(value, field, { minimum, maximum });
  if (new Set(list).size !== list.length) throw new Error(`${field} must be unique`);
  return list;
}

function digest(value: unknown, field: string): string {
  const result = contractText(value, field, 80);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${field} must be sha256:<hex>`);
  return result;
}
