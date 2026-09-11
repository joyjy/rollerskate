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

export function compileRunIntent(
  repoRoot: string,
  input: RunIntent | unknown,
  runtimeDirectory?: string
): StewardRunRequest {
  const intent = parseRunIntent(input);
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    return compileWithDatabase(repoRoot, intent, database, runtimeDirectory, {});
  } finally {
    database.close();
  }
}

export interface RunIntentOwnerPolicy {
  readonly mandate?: CompiledRunMandate;
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
    parseRunIntent(input),
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
  const intent = parseRunIntent(input);
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
  const configured = prior === undefined
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
  const participantAgentIds = resolveParticipants(
    intent.requestedParticipantRefs,
    steward.principalId,
    activeAgents
  );
  const workspace = resolveWorkspace(repoRoot, foundation.workspacePath, intent);
  if (policy.authorizeNetwork === true && (workspace?.access !== "read" || intent.triggerIntent !== undefined ||
    activeAgents.filter(a => participantAgentIds.includes(a.principalId)).some(a => a.client !== "codex"))) {
    throw new Error("Network preauthorization requires a standalone read-only Run with Codex participants");
  }
  const runtime = new RuntimeStore(database, { migrate: false });
  const resultDestination = resolveDestination(runtime, intent.resultDestinationRef);
  const trigger = resolveTriggerAuthority(repoRoot, intent, runtimeDirectory);
  const mandate = policy.mandate ?? { kind: "objective" as const, objective: intent.objective };
  const authority = parseRunAuthorityEnvelope({
    schemaVersion: "RunAuthorityEnvelope@1",
    ...(mandate.kind === "workflow" ? { workflowRef: mandate.workflowRef } : {}),
    participantAgentIds,
    ...(workspace === undefined ? {} : { workspace }),
    ...(trigger === undefined ? {} : { trigger }),
    destinationIds: resultDestination === undefined
      ? []
      : [resultDestination.destinationId],
    maxSteps: policy.maxSteps ?? 20,
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
  const byId = new Map(activeAgents.map((agent) => [agent.principalId, agent]));
  const byHandle = new Map(activeAgents.map((agent) => [
    normalizeAgentHandle(agent.handle).key,
    agent
  ]));
  const resolved = refs === undefined
    ? activeAgents.map(({ principalId }) => principalId)
    : refs.map((ref) => {
        const agent = ref.startsWith("agent:")
          ? byHandle.get(normalizeAgentHandle(ref.slice("agent:".length)).key)
          : ref.startsWith("principal:")
            ? byId.get(ref.slice("principal:".length))
            : undefined;
        if (agent === undefined) throw new Error(`Run participant ref is not active: ${ref}`);
        return agent.principalId;
      });
  return [...new Set([stewardAgentId, ...resolved])].sort();
}

function resolveWorkspace(
  repoRoot: string,
  localWorkspace: string,
  intent: RunIntent
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
  return {
    schemaVersion: "RunResultDestination@2",
    destinationId: destination.destinationId,
    delivery: {
      kind: destination.kind,
      address: destination.address
    }
  };
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
