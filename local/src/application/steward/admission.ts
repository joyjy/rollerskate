import { validateRunResultDestination } from "./result-destination.js";
import { assertExecutableGraph } from "../../modules/steward/graph-contract.js";
import { acceptanceContract } from "../../modules/steward/acceptance.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { StewardPolicyStore } from "../../infrastructure/files/steward-policy-store.js";
import { selectSteward, supportsStewardClient } from "../../modules/steward/steward-policy.js";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { RuntimeStore } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from "../../infrastructure/sqlite/schema/index.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { workspaceRevision } from "../../infrastructure/workspace/revision.js";
import { normalizeAgentHandle } from "../../modules/foundation/model.js";
import {
  parseRunAuthorityEnvelope,
  parseRunIntent,
  parseStewardRunRequest,
  runIntentDigest,
  type RunAuthorityEnvelope,
  type RunIntent,
  type CompiledRunMandate,
  type StewardRunRequest
} from "../../modules/steward/admission-contract.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";
import { registeredPluginsForTrigger } from
  "../subscription/plugin-registry.js";

export class StewardUnavailableError extends Error {}

function parseExecutableRunIntent(input: unknown): RunIntent {
  const intent = parseRunIntent(input);
  if (intent.graph !== undefined) {
    assertExecutableGraph(intent.graph);
    if (intent.desiredEffect === "change" || intent.triggerIntent !== undefined) throw new Error("DAG execution requires a standalone read-only Run");
  }
  return intent;
}

export function compileRunIntent(
  repoRoot: string,
  input: RunIntent | unknown,
  runtimeDirectory?: string
): StewardRunRequest {
  const intent = parseExecutableRunIntent(input);
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    return compileWithDatabase(repoRoot, intent, database, runtimeDirectory, {});
  } finally {
    database.close();
  }
}

export interface RunIntentOwnerPolicy {
  readonly mandate?: CompiledRunMandate;
  readonly stewardAgentId?: string;
  readonly authorizeNetwork?: boolean;
  readonly maxSteps?: number;
  readonly deadlineAt?: string;
}

export function compileRunIntentInDatabase(
  repoRoot: string,
  input: RunIntent | unknown,
  database: DatabaseSync,
  runtimeDirectory?: string,
  policy: RunIntentOwnerPolicy = {}
): StewardRunRequest {
  return compileWithDatabase(
    repoRoot,
    parseExecutableRunIntent(input),
    database,
    runtimeDirectory,
    policy
  );
}

export function compileRunIntentWithOwnerPolicy(
  repoRoot: string,
  input: RunIntent | unknown,
  policy: RunIntentOwnerPolicy,
  runtimeDirectory?: string
): StewardRunRequest {
  const intent = parseExecutableRunIntent(input);
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    return compileWithDatabase(repoRoot, intent, database, runtimeDirectory, policy);
  } finally {
    database.close();
  }
}

function compileWithDatabase(
  repoRoot: string,
  intent: RunIntent,
  database: DatabaseSync,
  runtimeDirectory: string | undefined,
  policy: RunIntentOwnerPolicy
): StewardRunRequest {
  assertCurrentLocalSchema(database);
  const foundationStore = new LocalFoundationStore(database, { migrate: false });
  const foundation = foundationStore.foundation();
  if (foundation === undefined) throw new Error("Local foundation is not initialized");
  const activeAgents = foundationStore.listAgents().filter(({ status }) => status === "active");
  const prior = new AgentRunStore(database, { migrate: false }).projectionByOwnerRequest(intent.requestId);
  const requestedSteward = intent.stewardRef === undefined ? undefined
    : resolveAgentRef(intent.stewardRef, activeAgents, "stewardRef");
  if (requestedSteward !== undefined && policy.stewardAgentId !== undefined && requestedSteward !== policy.stewardAgentId) {
    throw new Error("stewardRef conflicts with the caller's fixed Steward");
  }
  if (requestedSteward !== undefined && prior !== undefined && requestedSteward !== prior.stewardAgentId) {
    throw new Error("Run requestId is already bound to another Steward");
  }
  const selectedStewardId = policy.stewardAgentId ?? requestedSteward;
  const configured = selectedStewardId !== undefined
    ? {schemaVersion: "StewardPolicy@1" as const, entries: [{agentId: selectedStewardId, weight: 100}]}
    : prior === undefined
    ? new StewardPolicyStore(runtimePaths(repoRoot, runtimeDirectory).stewardPolicy).load()
    : undefined;
  const selection = prior?.orchestratorBinding?.schemaVersion === "OrchestratorBinding@3"
    ? prior.orchestratorBinding.selection
    : prior === undefined && configured !== undefined ? selectSteward(configured, intent.requestId) : undefined;
  const steward = prior !== undefined
    ? foundationStore.agent(prior.stewardAgentId)
    : selection === undefined ? foundationStore.agentByHandle("codex") : foundationStore.agent(selection.agentId);
  if (steward === undefined || steward.status !== "active" || !supportsStewardClient(steward.client)) {
    throw new StewardUnavailableError("Run admission requires an active supported Steward Agent; selected Agent is unavailable");
  }
  const workerAgentId = intent.workerRef === undefined ? undefined
    : resolveAgentRef(intent.workerRef, activeAgents, "workerRef");
  const participantAgentIds = resolveParticipants(
    intent.graph !== undefined ? Object.values(intent.graph.participants) : intent.workerRef !== undefined ? [intent.workerRef]
      : intent.requestedParticipantRefs ?? (intent.stewardRef === undefined ? undefined : []),
    steward.principalId,
    activeAgents
  );
  const workspace = inspectRunWorkspace(repoRoot, foundation.workspacePath, intent);
  if (policy.authorizeNetwork === true && (workspace === undefined || intent.triggerIntent !== undefined ||
    activeAgents.filter(a => participantAgentIds.includes(a.principalId)).some(a => a.client !== "codex"))) {
    throw new Error("Network preauthorization requires a standalone Run with Codex participants");
  }
  const runtime = new RuntimeStore(database, { migrate: false });
  const resultDestination = resolveDestination(runtime, intent.resultDestinationRef);
  const trigger = resolveTriggerAuthority(repoRoot, intent, runtimeDirectory);
  if (intent.graph !== undefined && policy.mandate !== undefined) throw new Error("DAG execution does not accept a workflow mandate override");
  const graph = intent.graph === undefined ? undefined : {
    ...intent.graph,
    participants: Object.fromEntries(Object.entries(intent.graph.participants).map(([alias, ref]) => [alias, `principal:${resolveAgentRef(ref, activeAgents, "graph participant")}`]))
  };
  if (graph !== undefined && policy.maxSteps !== undefined && policy.maxSteps < graph.nodes.length) throw new Error("DAG exceeds the admitted step budget");
  const mandate = policy.mandate ?? { kind: "objective" as const, objective: intent.objective };
  const authority = parseRunAuthorityEnvelope({
    schemaVersion: "RunAuthorityEnvelope@1",
    ...(mandate.kind === "workflow" ? { workflowRef: mandate.workflowRef } : {}),
    participantAgentIds,
    ...(workerAgentId === undefined ? {} : {workerAgentId}),
    ...(workspace === undefined ? {} : { workspace }),
    ...(trigger === undefined ? {} : { trigger }),
    destinationIds: resultDestination === undefined
      ? []
      : [resultDestination.destinationId],
    maxSteps: graph?.nodes.length ?? policy.maxSteps ?? 20,
    maxDepth: 0,
    ...(policy.deadlineAt === undefined ? {} : { deadlineAt: policy.deadlineAt })
  });
  const draft = {
    schemaVersion: "StewardRunRequest@2" as const,
    ...(selection === undefined ? {} : { stewardSelection: selection }),
    requestId: intent.requestId,
    idempotencyKey: intent.requestId,
    intentDigest: runIntentDigest(intent),
    objective: intent.objective,
    acceptanceContract: acceptanceContract(intent.acceptance, intent.contextRefs),
    ...(intent.dispatchNotes === undefined ? {} : {dispatchNotes: intent.dispatchNotes}),
    ...(policy.authorizeNetwork === true ? {ownerNetworkAuthorized: true} : {}),
    acceptance: intent.acceptance,
    contextRefs: intent.contextRefs,
    terminalEvidence: intent.terminalEvidence,
    mandate,
    ...(graph === undefined ? {} : {graph}),
    authority,
    ...(resultDestination === undefined ? {} : { resultDestination }),
    authoritySummary: authoritySummary(authority)
  };
  const admissionDigest = digest(draft);
  return parseStewardRunRequest({ ...draft, admissionDigest });
}

function resolveTriggerAuthority(
  repoRoot: string,
  intent: RunIntent,
  runtimeDirectory?: string
): RunAuthorityEnvelope["trigger"] | undefined {
  const kind = intent.triggerIntent;
  if (kind === undefined) return undefined;
  const plugins = registeredPluginsForTrigger(repoRoot, kind, runtimeDirectory);
  if ((kind === "until" || kind === "continuous") && plugins.length === 0) {
    throw new Error(`Run admission has no Owner-registered plugin for trigger: ${kind}`);
  }
  return {
    allowedKinds: [kind],
    minimumIntervalMilliseconds: 1_000,
    maximumIntervalMilliseconds: 31_536_000_000,
    pluginRefs: plugins.map(({ ref }) => ref),
    pluginPolicyDigests: Object.fromEntries(plugins.map(({ ref, authorityDigest }) => [
      ref,
      authorityDigest
    ])),
    allowedHttpOrigins: unique(plugins.flatMap(({ allowedHttpOrigins }) => allowedHttpOrigins)),
    allowedExecutables: unique(plugins.flatMap(({ allowedExecutables }) => allowedExecutables))
  };
}

function resolveParticipants(
  refs: readonly string[] | undefined,
  stewardAgentId: string,
  activeAgents: readonly {
    readonly principalId: string;
    readonly handle: string;
  }[]
): readonly string[] {
  const resolved = refs === undefined
    ? activeAgents.map(({ principalId }) => principalId)
    : refs.map(ref => resolveAgentRef(ref, activeAgents, "participant ref"));
  return [...new Set([stewardAgentId, ...resolved])].sort();
}

function resolveAgentRef(
  ref: string,
  activeAgents: readonly { readonly principalId: string; readonly handle: string }[],
  field: string
): string {
  const agent = ref.startsWith("agent:")
    ? activeAgents.find(candidate => normalizeAgentHandle(candidate.handle).key === normalizeAgentHandle(ref.slice(6)).key)
    : ref.startsWith("principal:")
      ? activeAgents.find(candidate => candidate.principalId === ref.slice(10))
      : undefined;
  if (agent === undefined) throw new Error(`Run ${field} is not active: ${ref}`);
  return agent.principalId;
}

export function inspectRunWorkspace(
  repoRoot: string,
  localWorkspace: string,
  intent: Pick<RunIntent, "workspaceRef" | "desiredEffect">
): RunAuthorityEnvelope["workspace"] | undefined {
  if (intent.workspaceRef === undefined) {
    if (intent.desiredEffect !== undefined && intent.desiredEffect !== "none") {
      throw new Error("desiredEffect requires workspaceRef");
    }
    return undefined;
  }
  if (intent.desiredEffect === "none") {
    throw new Error("workspaceRef conflicts with desiredEffect=none");
  }
  const rootInput = intent.workspaceRef === "project:self"
    ? repoRoot
    : intent.workspaceRef === "local:workspace"
      ? localWorkspace
      : fileWorkspace(intent.workspaceRef);
  const root = realpathSync(rootInput);
  if (!statSync(root).isDirectory()) throw new Error(`workspaceRef is not a directory: ${intent.workspaceRef}`);
  const revision = workspaceRevision(root).revision;
  const access = intent.desiredEffect === "change" ? "write" : "read";
  return {
    root,
    revision,
    access,
    ...(access === "write" ? { effect: "must_change" as const } : {}),
    networkAccess: false
  };
}

function fileWorkspace(ref: string): string {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new Error(`workspaceRef is not registered or a file URL: ${ref}`);
  }
  if (url.protocol !== "file:" || url.hostname !== "") {
    throw new Error(`workspaceRef is not registered or a local file URL: ${ref}`);
  }
  return fileURLToPath(url);
}

function resolveDestination(
  runtime: RuntimeStore,
  ref: string | undefined
): StewardRunRequest["resultDestination"] | undefined {
  if (ref === undefined) return undefined;
  if (!ref.startsWith("destination:")) {
    throw new Error(`resultDestinationRef is unsupported: ${ref}`);
  }
  const destinationId = ref.slice("destination:".length);
  const destination = runtime.destination(destinationId);
  if (destination === undefined) {
    throw new Error(`Run result destination is not registered: ${destinationId}`);
  }
  const result = {
    schemaVersion: "RunResultDestination@2" as const,
    destinationId: destination.destinationId,
    delivery: {
      kind: destination.kind,
      address: destination.address
    }
  };
  validateRunResultDestination(result);
  return result;
}

function authoritySummary(authority: RunAuthorityEnvelope): string {
  const workspace = authority.workspace === undefined
    ? "workspace=none"
    : `workspace=${authority.workspace.access}:${authority.workspace.revision.slice(0, 20)}`;
  const trigger = authority.trigger === undefined
    ? "trigger=none"
    : `trigger=${authority.trigger.allowedKinds.join(",")}`;
  return [
    workspace,
    `participants=${authority.participantAgentIds.length}`,
    "network=off",
    trigger,
    `destinations=${authority.destinationIds.length}`,
    `budget=${authority.maxSteps}/${authority.maxDepth}`
  ].join("; ");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableContractJson(value)).digest("hex")}`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
