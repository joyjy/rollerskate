export type SpecKind =
  | "contract"
  | "template"
  | "workflow"
  | "result-contract"
  | "capability";

export type SpecStatus = "active" | "historical";
export type CanonicalSpecRef = `spec:rollerskate/${string}@${number}`;
export type ArtifactDigest = `sha256:${string}`;

export interface SpecRefV1 {
  readonly schemaVersion: "SpecRef@1";
  readonly namespace: "rollerskate";
  readonly name: string;
  readonly major: number;
  readonly canonical: CanonicalSpecRef;
}

export interface SpecRegistryEntry<K extends SpecKind = SpecKind> {
  readonly ref: CanonicalSpecRef;
  readonly kind: K;
  readonly status: SpecStatus;
  readonly owner: string;
  readonly source: string;
  readonly parser: string;
  readonly payloadDiscriminators: readonly string[];
  readonly artifactDigest: ArtifactDigest | null;
  readonly capabilityRef?: CanonicalSpecRef;
}

export interface ResolveSpecOptions<K extends SpecKind> {
  readonly kind: K;
  readonly allowHistorical?: boolean;
}

const SPEC_REF_PATTERN =
  /^spec:rollerskate\/([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)@([1-9][0-9]{0,5})$/u;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function parseSpecRef(value: unknown): SpecRefV1 {
  if (typeof value !== "string") throw new Error("SpecRef@1 must be a string");
  const match = SPEC_REF_PATTERN.exec(value);
  if (match === null) {
    throw new Error("SpecRef@1 must use spec:rollerskate/<name>@<major>");
  }
  const name = match[1]!;
  const major = Number(match[2]);
  const canonical = `spec:rollerskate/${name}@${major}` as CanonicalSpecRef;
  if (canonical !== value) throw new Error("SpecRef@1 must be canonical");
  return {
    schemaVersion: "SpecRef@1",
    namespace: "rollerskate",
    name,
    major,
    canonical
  };
}

export function normalizeSpecRef(input: {
  readonly name: string;
  readonly major: number;
} | string): CanonicalSpecRef {
  if (typeof input === "string") return parseSpecRef(input).canonical;
  if (!Number.isInteger(input.major) || input.major < 1 || input.major > 999_999) {
    throw new Error("SpecRef@1 major must be an integer between 1 and 999999");
  }
  return parseSpecRef(`spec:rollerskate/${input.name}@${input.major}`).canonical;
}

export function parseArtifactDigest(value: unknown): ArtifactDigest {
  if (typeof value !== "string" || !ARTIFACT_DIGEST_PATTERN.test(value)) {
    throw new Error("artifactDigest must use sha256:<64 lowercase hex>");
  }
  return value as ArtifactDigest;
}

export class SpecRegistry {
  readonly #entries: readonly SpecRegistryEntry[];
  readonly #byRef: ReadonlyMap<CanonicalSpecRef, SpecRegistryEntry>;
  readonly #byDiscriminator: ReadonlyMap<string, SpecRegistryEntry>;

  public constructor(entries: readonly SpecRegistryEntry[]) {
    const byRef = new Map<CanonicalSpecRef, SpecRegistryEntry>();
    const byDiscriminator = new Map<string, SpecRegistryEntry>();
    const kindByName = new Map<string, SpecKind>();
    const frozenEntries: SpecRegistryEntry[] = [];
    for (const candidate of entries) {
      const parsed = parseSpecRef(candidate.ref);
      if (byRef.has(candidate.ref)) {
        throw new Error(`Duplicate spec registry ref: ${candidate.ref}`);
      }
      const existingKind = kindByName.get(parsed.name);
      if (existingKind !== undefined && existingKind !== candidate.kind) {
        throw new Error(`Spec registry name collision: ${parsed.name}`);
      }
      if (candidate.owner.trim() === "" || candidate.source.trim() === "" ||
        candidate.parser.trim() === "") {
        throw new Error(`Spec registry entry is missing owner/source/parser: ${candidate.ref}`);
      }
      if (candidate.artifactDigest !== null) {
        parseArtifactDigest(candidate.artifactDigest);
      }
      if (candidate.payloadDiscriminators.length === 0) {
        throw new Error(`Spec registry entry has no payload discriminator: ${candidate.ref}`);
      }
      const entry = Object.freeze({
        ...candidate,
        payloadDiscriminators: Object.freeze([...candidate.payloadDiscriminators])
      });
      for (const discriminator of candidate.payloadDiscriminators) {
        if (discriminator.trim() === "" || byDiscriminator.has(discriminator)) {
          throw new Error(`Duplicate spec registry discriminator: ${discriminator}`);
        }
        byDiscriminator.set(discriminator, entry);
      }
      kindByName.set(parsed.name, candidate.kind);
      byRef.set(candidate.ref, entry);
      frozenEntries.push(entry);
    }
    for (const candidate of entries) {
      if (candidate.capabilityRef !== undefined) {
        const capability = byRef.get(candidate.capabilityRef);
        if (candidate.kind !== "template" || capability?.kind !== "capability") {
          throw new Error(`Invalid template capability ref: ${candidate.ref}`);
        }
      }
    }
    this.#entries = Object.freeze(frozenEntries);
    this.#byRef = byRef;
    this.#byDiscriminator = byDiscriminator;
  }

  public entries(): readonly SpecRegistryEntry[] {
    return this.#entries;
  }

  public resolve<K extends SpecKind>(
    ref: unknown,
    options: ResolveSpecOptions<K>
  ): SpecRegistryEntry<K> {
    const canonical = parseSpecRef(ref).canonical;
    return this.#requireEntry(this.#byRef.get(canonical), canonical, options);
  }

  public resolveToken<K extends SpecKind>(
    token: unknown,
    options: ResolveSpecOptions<K>
  ): SpecRegistryEntry<K> {
    if (typeof token !== "string") throw new Error("Spec token must be a string");
    if (token.startsWith("spec:")) return this.resolve(token, options);
    const entry = this.#byDiscriminator.get(token);
    return this.#requireEntry(entry, token, options);
  }

  public assertCompatible<K extends SpecKind>(
    expected: unknown,
    actual: unknown,
    options: ResolveSpecOptions<K>
  ): SpecRegistryEntry<K> {
    const expectedEntry = this.resolveToken(expected, options);
    const actualEntry = this.resolveToken(actual, options);
    if (actualEntry.ref !== expectedEntry.ref) {
      throw new Error(`Incompatible ${options.kind} spec: expected ${expectedEntry.ref}, got ${actualEntry.ref}`);
    }
    return actualEntry;
  }

  public verifyArtifact(ref: unknown, digest: unknown): SpecRegistryEntry {
    const entry = this.resolveToken(ref, { kind: this.#kindOf(ref) });
    if (entry.artifactDigest === null) {
      if (digest !== null) {
        throw new Error(`${entry.ref} is code-native and must not declare artifactDigest`);
      }
      return entry;
    }
    const actual = parseArtifactDigest(digest);
    if (actual !== entry.artifactDigest) {
      throw new Error(`Artifact digest drift for ${entry.ref}`);
    }
    return entry;
  }

  #kindOf(ref: unknown): SpecKind {
    if (typeof ref !== "string") throw new Error("Spec token must be a string");
    const entry = ref.startsWith("spec:")
      ? this.#byRef.get(parseSpecRef(ref).canonical)
      : this.#byDiscriminator.get(ref);
    if (entry === undefined) throw new Error(`Unknown spec registry entry: ${ref}`);
    return entry.kind;
  }

  #requireEntry<K extends SpecKind>(
    entry: SpecRegistryEntry | undefined,
    input: string,
    options: ResolveSpecOptions<K>
  ): SpecRegistryEntry<K> {
    if (entry === undefined) throw new Error(`Unknown spec registry entry: ${input}`);
    if (entry.kind !== options.kind) {
      throw new Error(`Wrong spec kind for ${entry.ref}: expected ${options.kind}, got ${entry.kind}`);
    }
    if (entry.status === "historical" && options.allowHistorical !== true) {
      throw new Error(`Historical spec requires an explicit persisted-data reader: ${entry.ref}`);
    }
    return entry as SpecRegistryEntry<K>;
  }
}

export function createSpecRegistry(entries: readonly SpecRegistryEntry[]): SpecRegistry {
  return new SpecRegistry(entries);
}

function spec(
  name: string,
  major: number,
  entry: Omit<SpecRegistryEntry, "ref">
): SpecRegistryEntry {
  return { ref: normalizeSpecRef({ name, major }), ...entry };
}

const contract = (
  name: string,
  major: number,
  status: SpecStatus,
  owner: string,
  parser: string,
  payloadDiscriminators: readonly string[]
): SpecRegistryEntry => spec(name, major, {
  kind: "contract",
  status,
  owner,
  source: owner.split("#")[0]!,
  parser,
  payloadDiscriminators,
  artifactDigest: null
});

const resultContract = (
  name: string,
  major: number,
  status: SpecStatus,
  owner: string,
  parser: string,
  payloadDiscriminators: readonly string[]
): SpecRegistryEntry => spec(name, major, {
  kind: "result-contract",
  status,
  owner,
  source: owner.split("#")[0]!,
  parser,
  payloadDiscriminators,
  artifactDigest: null
});
const SCHEDULED_TASK_CAPABILITY = normalizeSpecRef({ name: "scheduled-task", major: 1 });
const SUBSCRIPTION_CAPABILITY = normalizeSpecRef({ name: "subscription", major: 1 });

export const ROLLERSKATE_SPEC_REGISTRY = createSpecRegistry([
  contract("spec-ref", 1, "active", "local/src/modules/spec/registry.ts#SpecRefV1", "parseSpecRef", ["SpecRef@1"]),
  contract("steward-policy", 1, "active", "local/src/modules/steward/steward-policy.ts#StewardPolicy", "parseStewardPolicy", ["StewardPolicy@1"]),
  contract("run-intent", 1, "active", "local/src/modules/steward/admission-contract.ts#RunIntent", "parseRunIntent", ["RunIntent@1"]),
  contract("run-intent", 2, "active", "local/src/modules/run/intent.ts#DeterministicRunIntent", "parseWorkRunIntent", ["RunIntent@2"]),
  contract("steward-run-request", 2, "active", "local/src/modules/steward/admission-contract.ts#StewardRunRequest", "parseStewardRunRequest", ["StewardRunRequest@2"]),
  contract("run-authority-envelope", 1, "active", "local/src/modules/steward/admission-contract.ts#RunAuthorityEnvelope", "parseRunAuthorityEnvelope", ["RunAuthorityEnvelope@1"]),
  contract("orchestrator-binding", 1, "active", "local/src/modules/steward/caller-contract.ts#ManualCallerOrchestratorBinding", "parseCallerOrchestratorBinding", ["OrchestratorBinding@1"]),
  contract("orchestrator-binding", 2, "historical", "local/src/modules/steward/caller-contract.ts#StewardOrchestratorBinding", "parseCallerOrchestratorBinding", ["OrchestratorBinding@2"]),
  contract("orchestrator-binding", 3, "active", "local/src/modules/steward/run-contract-v3.ts#StewardOrchestratorBindingV3", "parseStewardOrchestratorBindingV3", ["OrchestratorBinding@3"]),
  resultContract("run-decision", 1, "active", "local/src/modules/steward/caller-contract.ts#RunDecision", "parseRunDecision", ["RunDecision@1", "run-decision@1"]),
  resultContract("run-decision", 2, "historical", "local/src/modules/steward/caller-contract.ts#StewardRunDecision", "parseRunDecision", ["RunDecision@2", "run-decision@2"]),
  resultContract("run-decision", 3, "active", "local/src/modules/steward/run-contract-v3.ts#StewardRunDecisionV3", "parseStewardRunDecisionV3", ["RunDecision@3", "run-decision@3"]),
  resultContract("run-decision", 4, "active", "local/src/modules/steward/run-contract-v4.ts#StewardRunDecisionV4", "parseStewardRunDecisionV4", ["RunDecision@4", "run-decision@4"]),
  resultContract("run-decision", 6, "active", "local/src/modules/steward/run-contract-v6.ts#StewardRunDecisionV6", "parseStewardRunDecisionV6", ["RunDecision@6", "run-decision@6"]),
  resultContract("run-decision", 5, "active", "local/src/modules/steward/run-contract-v5.ts#StewardRunDecisionV5", "parseStewardRunDecisionV5", ["RunDecision@5", "run-decision@5"]),
  resultContract("agent-step-result", 1, "active", "local/src/modules/steward/caller-contract.ts#AgentStepResult", "parseAgentStepResult", ["AgentStepResult@1", "agent-step-result@1"]),
  contract("agent-run-checkpoint", 1, "active", "local/src/modules/steward/caller-contract.ts#AgentRunCheckpoint", "parseAgentRunCheckpoint", ["AgentRunCheckpoint@1"]),
  contract("run-source-binding", 1, "active", "local/src/modules/steward/source-contract.ts#RunSourceBinding", "parseRunSourceBinding", ["RunSourceBinding@1"]),
  contract("schedule-revision", 1, "historical", "local/src/capabilities/scheduled-task/model.ts#LegacyScheduleRevision", "parseScheduleDefinitionSnapshot", ["ScheduleRevision@1"]),
  contract("schedule-revision", 2, "historical", "local/src/capabilities/scheduled-task/model.ts#BoundScheduleRevision", "parseScheduleDefinitionSnapshot", ["ScheduleRevision@2"]),
  contract("schedule-revision", 3, "active", "local/src/capabilities/scheduled-task/model.ts#TargetedScheduleRevision", "parseScheduleDefinitionSnapshot", ["ScheduleRevision@3"]),
  contract("subscription-definition", 3, "historical", "local/src/capabilities/subscription/model.ts#FreeSubscriptionDefinition", "validateDefinition", ["SubscriptionDefinition@3"]),
  contract("subscription-definition", 4, "historical", "local/src/capabilities/subscription/model.ts#BoundSubscriptionDefinition", "validateBoundDefinition", ["SubscriptionDefinition@4"]),
  contract("subscription-definition", 5, "active", "local/src/capabilities/subscription/model.ts#TargetedSubscriptionDefinition", "validateTargetedDefinition", ["SubscriptionDefinition@5"]),
  contract("continuous-subscription-definition", 1, "historical", "local/src/capabilities/subscription/continuous-model.ts#LegacyContinuousSubscriptionDefinition", "validateDefinition", ["ContinuousSubscriptionDefinition@1"]),
  contract("continuous-subscription-definition", 2, "historical", "local/src/capabilities/subscription/continuous-model.ts#BoundContinuousSubscriptionDefinition", "validateBoundDefinition", ["ContinuousSubscriptionDefinition@2"]),
  contract("continuous-subscription-definition", 3, "active", "local/src/capabilities/subscription/continuous-model.ts#TargetedContinuousSubscriptionDefinition", "validateTargetedDefinition", ["ContinuousSubscriptionDefinition@3"]),
  contract("continuous-subscription-definition", 4, "active", "local/src/capabilities/subscription/continuous-model.ts#FileContinuousSubscriptionDefinition", "createFileInTransaction", ["ContinuousSubscriptionDefinition@4"]),
  contract("proactive-target", 1, "active", "local/src/modules/proactive/target.ts#ProactiveTarget", "parseProactiveTarget", ["ProactiveTarget@1"]),
  contract("deterministic-application-action-receipt", 1, "active", "local/src/modules/proactive/target.ts#DeterministicApplicationActionReceipt", "parseDeterministicApplicationActionReceipt", ["DeterministicApplicationActionReceipt@1"]),
  contract("trigger-occurrence-envelope", 1, "active", "local/src/modules/steward/source-contract.ts#TriggerOccurrenceEnvelope", "parseTriggerOccurrenceEnvelope", ["TriggerOccurrenceEnvelope@1"]),
  contract("run-result-destination", 2, "active", "local/src/modules/steward/caller-contract.ts#RunResultDestination", "parseCallerOrchestratorBinding", ["RunResultDestination@2"]),
  contract("agent-run-context", 1, "active", "local/src/modules/steward/state-machine.ts#AgentRunContext", "RuntimeStore.decodeRunContext", ["AgentRunContext@1"]),
  contract("run-mandate-snapshot", 1, "active", "local/src/modules/steward/state-machine.ts#RunMandateSnapshot", "workflowMandateSnapshot", ["RunMandateSnapshot@1"]),
  contract("orchestrator-state", 1, "active", "local/src/modules/steward/caller-contract.ts#OrchestratorState", "parseRunDecision", ["OrchestratorState@1"]),
  contract("agent-run-decision-receipt", 1, "historical", "local/src/modules/steward/caller-contract.ts#AgentRunDecisionReceiptV1", "parseAgentRunDecisionReceipt", ["AgentRunDecisionReceipt@1"]),
  contract("agent-run-decision-receipt", 2, "active", "local/src/modules/steward/caller-contract.ts#AgentRunDecisionReceiptV2", "parseAgentRunDecisionReceipt", ["AgentRunDecisionReceipt@2"]),
  contract("agent-run-decision-receipt", 3, "active", "local/src/modules/steward/caller-contract.ts#AgentRunHumanQuestionReceipt", "parseAgentRunDecisionReceipt", ["AgentRunDecisionReceipt@3"]),
  resultContract("agent-turn-result", 1, "active", "local/src/modules/steward/result-contract.ts#AgentTurnResult", "parseAgentTurnResult", ["AgentTurnResult@1", "agent-turn-result@1"]),
  resultContract("agent-turn-adjudication", 1, "active", "local/src/modules/steward/result-adjudication.ts#AgentTurnAdjudication", "parseAgentTurnAdjudication", ["AgentTurnAdjudication@1", "agent-turn-adjudication@1"]),
  resultContract("agent-turn-retry-result", 1, "active", "local/src/application/steward/result-recovery.ts#AgentTurnRetryContinuation", "parseAgentTurnResult", ["agent-turn-retry-result@1"]),
  spec("review", 1, {
    kind: "workflow", status: "active",
    owner: "local/resources/workflows/review.md",
    source: "local/resources/workflows/review.md",
    parser: "workflowMandateSnapshot", payloadDiscriminators: ["review@1"],
    artifactDigest: "sha256:0067e1e1efd5cc0633990b70bdce4c34e1dbd62708530a3d2ee444fdc51d7ca2"
  }),
  spec("mr-readiness", 1, {
    kind: "workflow", status: "active",
    owner: "local/resources/workflows/mr-readiness.md",
    source: "local/resources/workflows/mr-readiness.md",
    parser: "workflowMandateSnapshot", payloadDiscriminators: ["mr-readiness@1"],
    artifactDigest: "sha256:4df59c6666c241f61732a4da9ee8a19c1cdfc2eb62af16c06cd02d8a2b1fc8cc"
  }),
  spec("forum", 1, {
    kind: "workflow", status: "active",
    owner: "local/resources/workflows/forum.md",
    source: "local/resources/workflows/forum.md",
    parser: "workflowMandateSnapshot", payloadDiscriminators: ["forum@1"],
    artifactDigest: "sha256:f2a742a98fb9c834f758c6d7ddb03329b8a4e33a6d4933a604fb6d57400751db"
  }),
  spec("continuous-observation-monitor", 1, {
    kind: "workflow", status: "active",
    owner: "local/resources/workflows/continuous-observation-monitor.md",
    source: "local/resources/workflows/continuous-observation-monitor.md",
    parser: "workflowMandateSnapshot",
    payloadDiscriminators: ["continuous-observation-monitor@1"],
    artifactDigest: "sha256:ef0c5098a785d83c31d6e8b88a26e07362fb401ed2eaad7c48b8da0d5922a112"
  }),
  spec("scheduled-task", 1, {
    kind: "capability", status: "active",
    owner: "local/src/capabilities/scheduled-task/",
    source: "local/src/capabilities/scheduled-task/model.ts",
    parser: "normalizeBoundRevision", payloadDiscriminators: ["scheduled-task@1"],
    artifactDigest: null
  }),
  spec("subscription", 1, {
    kind: "capability", status: "active",
    owner: "local/src/capabilities/subscription/",
    source: "local/src/capabilities/subscription/model.ts",
    parser: "validateBoundDefinition", payloadDiscriminators: ["subscription@1"],
    artifactDigest: null
  }),
  spec("schedule.once", 1, {
    kind: "template", status: "active",
    owner: "local/src/application/schedule/source-binding.ts#parseScheduleTemplate",
    source: "local/src/application/schedule/source-binding.ts",
    parser: "parseScheduleTemplate", payloadDiscriminators: ["schedule.once@1"],
    artifactDigest: null, capabilityRef: SCHEDULED_TASK_CAPABILITY
  }),
  spec("schedule.cron", 1, {
    kind: "template", status: "active",
    owner: "local/src/application/schedule/source-binding.ts#parseScheduleTemplate",
    source: "local/src/application/schedule/source-binding.ts",
    parser: "parseScheduleTemplate", payloadDiscriminators: ["schedule.cron@1"],
    artifactDigest: null, capabilityRef: SCHEDULED_TASK_CAPABILITY
  }),
  spec("subscription.until", 1, {
    kind: "template", status: "active",
    owner: "local/src/application/subscription/source-binding.ts#parseTemplate",
    source: "local/src/application/subscription/source-binding.ts",
    parser: "parseTemplate", payloadDiscriminators: ["subscription.until@1"],
    artifactDigest: null, capabilityRef: SUBSCRIPTION_CAPABILITY
  }),
  spec("subscription.continuous", 1, {
    kind: "template", status: "active",
    owner: "local/src/application/subscription/source-binding.ts#parseTemplate",
    source: "local/src/application/subscription/source-binding.ts",
    parser: "parseTemplate", payloadDiscriminators: ["subscription.continuous@1"],
    artifactDigest: null, capabilityRef: SUBSCRIPTION_CAPABILITY
  })
]);

export function resolveSpecRef<K extends SpecKind>(
  ref: unknown,
  options: ResolveSpecOptions<K>
): SpecRegistryEntry<K> {
  return ROLLERSKATE_SPEC_REGISTRY.resolve(ref, options);
}

export function resolveSpecToken<K extends SpecKind>(
  token: unknown,
  options: ResolveSpecOptions<K>
): SpecRegistryEntry<K> {
  return ROLLERSKATE_SPEC_REGISTRY.resolveToken(token, options);
}

export function assertSpecCompatibility<K extends SpecKind>(
  expected: unknown,
  actual: unknown,
  options: ResolveSpecOptions<K>
): SpecRegistryEntry<K> {
  return ROLLERSKATE_SPEC_REGISTRY.assertCompatible(expected, actual, options);
}

export function verifySpecArtifact(ref: unknown, digest: unknown): SpecRegistryEntry {
  return ROLLERSKATE_SPEC_REGISTRY.verifyArtifact(ref, digest);
}

export function specRegistryInventory(): readonly SpecRegistryEntry[] {
  return ROLLERSKATE_SPEC_REGISTRY.entries();
}
