import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { RuntimeStore } from "../../core/runtime/store.js";
import { workflowMandateSnapshot } from
  "../../infrastructure/resources/workflow-resource.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  legacyMigrationSnapshots,
  readLegacyMigrationSnapshots,
  type LegacyMigrationSourceSnapshot
} from "../../infrastructure/sqlite/legacy-trigger-migration-query.js";
import {
  openRuntimeDatabase,
  openRuntimeDatabaseReadOnly
} from "../../infrastructure/sqlite/database.js";
import { initializeRuntimeSchema } from "../../infrastructure/sqlite/schema.js";
import { tableExists } from "../../infrastructure/sqlite/schema/introspection.js";
import type { CompiledRunMandate, RunIntent } from
  "../../modules/steward/admission-contract.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";
import { compileRunIntentInDatabase } from "./admission.js";
import { startStewardRunFromAdmissionInTransaction } from "./intent-control.js";
import {
  listRegisteredLegacyTriggerWorkflows,
  type RegisteredLegacyTriggerWorkflow
} from "./legacy-workflow-registry.js";
import { listRegisteredSubscriptionPlugins } from
  "../subscription/plugin-registry.js";

type MigrationDisposition =
  | "ready"
  | "owner_decision"
  | "blocked_reconcile"
  | "already_applied";

export interface LegacyTriggerMigrationProposal {
  readonly schemaVersion: "LegacyTriggerMigrationProposal@1";
  readonly proposalDigest: string;
  readonly source: {
    readonly kind: LegacyMigrationSourceSnapshot["ownerKind"];
    readonly id: string;
    readonly definitionSchema: string;
    readonly definitionRevision: string;
    readonly status: "active" | "paused";
  };
  readonly disposition: MigrationDisposition;
  readonly reasons: readonly string[];
  readonly migrationRequestId: string;
  readonly candidate?: {
    readonly intent: RunIntent;
    readonly mandate?: CompiledRunMandate;
    readonly workflowArtifactDigest?: string;
    readonly sourceTemplate: {
      readonly sourceKind: "schedule" | "subscription" | "continuous_subscription";
      readonly templateId: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    };
    readonly authorityDelta: Readonly<Record<string, unknown>>;
  };
  readonly existingRun?: {
    readonly runId: string;
    readonly status: string;
    readonly createdAt: string;
    readonly admissionDigest: string;
  };
  readonly existingReceipt?: LegacyTriggerMigrationReceipt;
}

export interface LegacyTriggerMigrationPlan {
  readonly schemaVersion: "LegacyTriggerMigrationPlan@1";
  readonly generatedAt: string;
  readonly summary: Readonly<Record<MigrationDisposition, number>>;
  readonly proposals: readonly LegacyTriggerMigrationProposal[];
}

export interface LegacyTriggerMigrationApproval {
  readonly schemaVersion: "LegacyTriggerMigrationApproval@1";
  readonly proposalDigest: string;
  readonly source: {
    readonly kind: LegacyMigrationSourceSnapshot["ownerKind"];
    readonly id: string;
    readonly definitionRevision: string;
  };
}

export interface LegacyTriggerMigrationReceipt {
  readonly schemaVersion: "LegacyTriggerMigrationReceipt@1";
  readonly status: "applied" | "duplicate";
  readonly proposalDigest: string;
  readonly source: LegacyTriggerMigrationApproval["source"];
  readonly oldDefinitionStatus: "active" | "paused";
  readonly newDefinitionStatus: "paused";
  readonly runId: string;
  readonly admissionDigest: string;
  readonly migrationRequestId: string;
  readonly appliedAt: string;
}

export function legacyTriggerMigrationPlan(
  repoRoot: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): LegacyTriggerMigrationPlan {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const snapshots = readLegacyMigrationSnapshots(paths.database);
  const database = openRuntimeDatabaseReadOnly(paths.database);
  try {
    return migrationPlan(repoRoot, database, snapshots, runtimeDirectory, at);
  } finally {
    database.close();
  }
}

export function applyLegacyTriggerMigration(
  repoRoot: string,
  value: unknown,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): LegacyTriggerMigrationReceipt {
  const approval = parseApproval(value);
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  const database = openRuntimeDatabase(paths.database);
  try {
    const initial = findApprovedProposal(
      migrationPlan(
        repoRoot,
        database,
        legacyMigrationSnapshots(database),
        runtimeDirectory,
        at
      ),
      approval
    );
    if (initial.disposition === "already_applied") {
      return receiptForExisting(initial, approval);
    }
    if (initial.disposition !== "ready" || initial.candidate === undefined) {
      throw new Error(
        `Legacy migration is not ready: ${initial.reasons.join("; ") || initial.disposition}`
      );
    }
    const runtime = new RuntimeStore(database);
    try {
      return runtime.withImmediateTransaction(() => {
        const current = findApprovedProposal(
          migrationPlan(
            repoRoot,
            database,
            legacyMigrationSnapshots(database),
            runtimeDirectory,
            at
          ),
          approval
        );
        if (current.disposition === "already_applied") {
          return receiptForExisting(current, approval);
        }
        if (current.disposition !== "ready" || current.candidate === undefined ||
          stableContractJson(current.candidate) !==
            stableContractJson(initial.candidate)) {
          throw new Error("Legacy migration proposal changed before apply");
        }
        const admission = compileRunIntentInDatabase(
          repoRoot,
          current.candidate.intent,
          database,
          runtimeDirectory,
          current.candidate.mandate === undefined
            ? {}
            : { mandate: current.candidate.mandate }
        );
        const started = startStewardRunFromAdmissionInTransaction(
          admission,
          database,
          at
        );
        pauseLegacySource(database, current, at);
        const receipt: LegacyTriggerMigrationReceipt = {
          schemaVersion: "LegacyTriggerMigrationReceipt@1",
          status: started.status === "duplicate" ? "duplicate" : "applied",
          proposalDigest: approval.proposalDigest,
          source: approval.source,
          oldDefinitionStatus: current.source.status,
          newDefinitionStatus: "paused",
          runId: started.run.runId,
          admissionDigest: admission.admissionDigest,
          migrationRequestId: current.migrationRequestId,
          appliedAt: started.run.createdAt
        };
        recordMigrationReceipt(database, receipt);
        return receipt;
      });
    } finally {
      runtime.close();
    }
  } finally {
    database.close();
  }
}

function migrationPlan(
  repoRoot: string,
  database: DatabaseSync,
  snapshots: readonly LegacyMigrationSourceSnapshot[],
  runtimeDirectory: string | undefined,
  at: string
): LegacyTriggerMigrationPlan {
  const generatedAt = new Date(at).toISOString();
  let plugins: ReturnType<typeof listRegisteredSubscriptionPlugins> | undefined;
  const registeredPlugins = (): ReturnType<typeof listRegisteredSubscriptionPlugins> => {
    plugins ??= listRegisteredSubscriptionPlugins(repoRoot, runtimeDirectory);
    return plugins;
  };
  let workflows: ReturnType<typeof listRegisteredLegacyTriggerWorkflows> | undefined;
  const registeredWorkflows = (): ReturnType<
    typeof listRegisteredLegacyTriggerWorkflows
  > => {
    workflows ??= listRegisteredLegacyTriggerWorkflows(repoRoot, runtimeDirectory);
    return workflows;
  };
  const proposals = snapshots.map((snapshot) => proposal(
    snapshot,
    database,
    registeredPlugins,
    registeredWorkflows
  ));
  return {
    schemaVersion: "LegacyTriggerMigrationPlan@1",
    generatedAt,
    summary: {
      ready: proposals.filter(({ disposition }) => disposition === "ready").length,
      owner_decision: proposals.filter(
        ({ disposition }) => disposition === "owner_decision"
      ).length,
      blocked_reconcile: proposals.filter(
        ({ disposition }) => disposition === "blocked_reconcile"
      ).length,
      already_applied: proposals.filter(
        ({ disposition }) => disposition === "already_applied"
      ).length
    },
    proposals
  };
}

function proposal(
  snapshot: LegacyMigrationSourceSnapshot,
  database: DatabaseSync,
  registeredPlugins: () => ReturnType<typeof listRegisteredSubscriptionPlugins>,
  registeredWorkflows: () => ReturnType<typeof listRegisteredLegacyTriggerWorkflows>
): LegacyTriggerMigrationProposal {
  const snapshotContract = {
    ownerKind: snapshot.ownerKind,
    ownerId: snapshot.ownerId,
    definitionSchema: snapshot.definitionSchema,
    definitionRevision: snapshot.definitionRevision,
    callbackOwnerRevision: snapshot.callbackOwnerRevision,
    source: snapshot.source,
    callbacks: snapshot.callbacks
  };
  const migrationRequestId = migrationRequest(snapshot);
  const storedReceipt = storedMigrationReceipt(database, snapshot);
  const existing = database.prepare(`
    SELECT run_id, status, created_at,
      json_extract(orchestrator_binding_json, '$.admissionDigest') AS admission_digest
    FROM agent_runs WHERE owner_request_id = ?
  `).get(migrationRequestId) as {
    run_id: string;
    status: string;
    created_at: string;
    admission_digest: string | null;
  } | undefined;
  const base = (proposalDigest: string) => ({
    schemaVersion: "LegacyTriggerMigrationProposal@1" as const,
    proposalDigest,
    source: {
      kind: snapshot.ownerKind,
      id: snapshot.ownerId,
      definitionSchema: snapshot.definitionSchema,
      definitionRevision: snapshot.definitionRevision,
      status: snapshot.ownerStatus
    },
    migrationRequestId
  });
  if (storedReceipt !== undefined) {
    if (snapshot.ownerStatus !== "paused") {
      return {
        ...base(storedReceipt.proposalDigest),
        disposition: "blocked_reconcile",
        reasons: ["migration receipt exists but the legacy source is active"],
        existingReceipt: storedReceipt
      };
    }
    return {
      ...base(storedReceipt.proposalDigest),
      disposition: "already_applied",
      reasons: ["durable migration receipt exists and legacy source is paused"],
      existingRun: {
        runId: storedReceipt.runId,
        status: existing?.status ?? "unknown",
        createdAt: storedReceipt.appliedAt,
        admissionDigest: storedReceipt.admissionDigest
      },
      existingReceipt: storedReceipt
    };
  }
  if (snapshot.unterminatedOccurrences > 0) {
    return {
      ...base(digest({ snapshot: snapshotContract, disposition: "blocked_reconcile" })),
      disposition: "blocked_reconcile",
      reasons: [
        `${snapshot.unterminatedOccurrences} pending/started/unknown callback occurrence(s)`
      ]
    };
  }
  if (snapshot.callbacks.length !== 1) {
    return {
      ...base(digest({ snapshot: snapshotContract, disposition: "owner_decision" })),
      disposition: "owner_decision",
      reasons: [automaticMappingRejection(snapshot)]
    };
  }
  try {
    const callback = snapshot.callbacks[0]!;
    const candidate = callback.kind === "agent.invoke"
      ? migrationCandidate(snapshot, registeredPlugins)
      : callback.kind === "command.exec"
        ? commandWorkflowMigrationCandidate(
            snapshot,
            registeredPlugins,
            requireWorkflowMapping(snapshot, callback.callbackId, registeredWorkflows())
          )
        : undefined;
    if (candidate === undefined) {
      throw new Error(automaticMappingRejection(snapshot));
    }
    assertCandidatePrincipals(database, candidate.intent);
    assertCandidateDestination(database, candidate.intent);
    const proposalDigest = digest({ snapshot: snapshotContract, candidate });
    if (existing !== undefined && snapshot.ownerStatus === "paused") {
      if (existing.admission_digest === null) {
        throw new Error("existing migration Run has no OrchestratorBinding@3 admission digest");
      }
      return {
        ...base(proposalDigest),
        disposition: "already_applied",
        reasons: ["deterministic migration Run exists and legacy source is paused"],
        candidate,
        existingRun: {
          runId: existing.run_id,
          status: existing.status,
          createdAt: existing.created_at,
          admissionDigest: digestValue(existing.admission_digest, "existing admissionDigest")
        }
      };
    }
    return { ...base(proposalDigest), disposition: "ready", reasons: [], candidate };
  } catch (error) {
    return {
      ...base(digest({ snapshot: snapshotContract, disposition: "owner_decision" })),
      disposition: "owner_decision",
      reasons: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function automaticMappingRejection(snapshot: LegacyMigrationSourceSnapshot): string {
  if (snapshot.callbacks.length === 0) {
    return "definition has no agent.invoke work to recompile";
  }
  if (snapshot.callbacks.length > 1) {
    return "multiple callbacks require an Owner-approved single terminal objective";
  }
  const kind = snapshot.callbacks[0]!.kind;
  if (kind === "command.exec") {
    return "command.exec requires an Owner-approved versioned workflow";
  }
  if (kind === "destination.deliver") {
    return "destination.deliver requires an Owner-approved terminal result role";
  }
  return "only one agent.invoke callback can be mapped automatically";
}

function migrationCandidate(
  snapshot: LegacyMigrationSourceSnapshot,
  registeredPlugins: () => ReturnType<typeof listRegisteredSubscriptionPlugins>
): NonNullable<LegacyTriggerMigrationProposal["candidate"]> {
  const callback = snapshot.callbacks[0]!;
  const definition = callback.definition;
  const grant = callback.grant;
  const agentId = fieldText(definition, "agentId");
  const workspace = realpathSync(fieldText(definition, "workspace"));
  if (!statSync(workspace).isDirectory()) throw new Error("legacy workspace is not a directory");
  if (grant.agentId !== agentId || realpathSync(fieldText(grant, "workspace")) !== workspace) {
    throw new Error("legacy agent callback definition and grant do not match");
  }
  const workspaceAccess = grant.workspaceAccess;
  if (workspaceAccess !== "read" && workspaceAccess !== "write") {
    throw new Error("legacy agent callback workspace access is unsupported");
  }
  const plugins = snapshot.ownerKind === "schedule" ? [] : registeredPlugins();
  const sourceTemplate = compileSourceTemplate(snapshot, plugins);
  const replacementPlugin = sourceTemplate.sourceKind === "schedule"
    ? undefined
    : plugins.find(({ ref }) => ref === sourceTemplate.parameters.pluginRef);
  const legacyProbePolicy = snapshot.ownerKind === "schedule"
    ? undefined
    : fieldRecord(snapshot.source, "policy");
  const prompt = fieldText(definition, "prompt");
  const intent: RunIntent = {
    schemaVersion: "RunIntent@1",
    requestId: migrationRequest(snapshot),
    objective: [
      `Replace legacy ${snapshot.ownerKind}:${snapshot.ownerId} with one Run-bound source.`,
      `On the first turn bind exactly this source template: ${stableContractJson(sourceTemplate)}.`,
      `For each occurrence complete this legacy objective exactly once: ${prompt}`
    ].join(" "),
    acceptance: [
      "The replacement source contains no legacy callbacks",
      "Each occurrence activates at most one Run cycle",
      "The legacy agent objective is checked within the admitted workspace authority"
    ],
    contextRefs: [
      `legacy-trigger:${snapshot.ownerKind}:${snapshot.ownerId}:${snapshot.definitionRevision}`,
      `legacy-callback:${callback.callbackId}`
    ],
    workspaceRef: pathToFileURL(workspace).href,
    desiredEffect: workspaceAccess === "write" ? "change" : "read",
    triggerIntent: snapshot.ownerKind === "schedule"
      ? fieldText(snapshot.source, "kind") as "once" | "cron"
      : snapshot.ownerKind === "subscription"
        ? "until"
        : "continuous",
    requestedParticipantRefs: [`principal:${agentId}`],
    terminalEvidence: [
      "Run Workspace shows the source occurrence and cycle receipt",
      "Worker result records observed workspace revision and acceptance evidence"
    ]
  };
  return {
    intent,
    sourceTemplate,
    authorityDelta: {
      oldWorkspaceAccess: workspaceAccess,
      newDesiredEffect: intent.desiredEffect,
      oldNetworkAccess: grant.networkAccess === true,
      newNetworkAccess: false,
      oldSessionIdRetained: false,
      ...(sourceTemplate.sourceKind === "schedule"
        ? {}
        : {
            pluginRef: fieldText(sourceTemplate.parameters, "pluginRef"),
            oldProbeAllowedHttpOrigins: fieldStrings(
              legacyProbePolicy!,
              "allowedHttpOrigins"
            ),
            newProbeAllowedHttpOrigins: replacementPlugin!.allowedHttpOrigins,
            oldProbeAllowedExecutables: fieldStrings(
              legacyProbePolicy!,
              "allowedExecutables"
            ),
            newProbeAllowedExecutables: replacementPlugin!.allowedExecutables
          })
    }
  };
}

function commandWorkflowMigrationCandidate(
  snapshot: LegacyMigrationSourceSnapshot,
  registeredPlugins: () => ReturnType<typeof listRegisteredSubscriptionPlugins>,
  mapping: RegisteredLegacyTriggerWorkflow
): NonNullable<LegacyTriggerMigrationProposal["candidate"]> {
  const callback = snapshot.callbacks[0]!;
  const sourceTemplate = compileSourceTemplate(snapshot, registeredPlugins());
  const inputs = {
    legacySource: {
      kind: snapshot.ownerKind,
      id: snapshot.ownerId,
      definitionRevision: snapshot.definitionRevision
    },
    sourceTemplate
  };
  const workflowArtifactDigest = digest(workflowMandateSnapshot(mapping.workflowRef, inputs));
  const mandate: CompiledRunMandate = {
    kind: "workflow",
    workflowRef: mapping.workflowRef,
    inputs
  };
  const destinationAcceptance = mapping.resultDestinationRef === undefined
    ? []
    : ["Each cycle terminal result is sent to the approved destination"];
  const destinationEvidence = mapping.resultDestinationRef === undefined
    ? []
    : ["The approved result destination has one terminal Delivery per cycle"];
  const intent: RunIntent = {
    schemaVersion: "RunIntent@1",
    requestId: migrationRequest(snapshot),
    objective: `Replace legacy ${snapshot.ownerKind}:${snapshot.ownerId} with ` +
      `Owner workflow ${mapping.workflowRef}.`,
    acceptance: [
      "The replacement source contains no legacy callbacks",
      "Each occurrence activates at most one Run cycle",
      ...destinationAcceptance
    ],
    contextRefs: [
      `legacy-trigger:${snapshot.ownerKind}:${snapshot.ownerId}:${snapshot.definitionRevision}`,
      `legacy-callback:${callback.callbackId}`,
      `workflow:${mapping.workflowRef}`
    ],
    desiredEffect: "none",
    triggerIntent: snapshot.ownerKind === "schedule"
      ? fieldText(snapshot.source, "kind") as "once" | "cron"
      : snapshot.ownerKind === "subscription" ? "until" : "continuous",
    ...(mapping.resultDestinationRef === undefined
      ? {}
      : { resultDestinationRef: mapping.resultDestinationRef }),
    requestedParticipantRefs: [mapping.participantRef],
    terminalEvidence: [
      "Run Workspace shows the source occurrence and cycle receipt",
      ...destinationEvidence
    ]
  };
  const grant = callback.grant;
  return {
    intent,
    mandate,
    workflowArtifactDigest,
    sourceTemplate,
    authorityDelta: {
      oldCallbackKind: callback.kind,
      oldNetworkAccess: grant.networkAccess === true,
      newNetworkAccess: false,
      newDesiredEffect: "none",
      oldSessionIdRetained: false,
      workflowRef: mapping.workflowRef,
      terminalResultPolicy: mapping.terminalResultPolicy,
      ...(mapping.resultDestinationRef === undefined
        ? {}
        : { resultDestinationRef: mapping.resultDestinationRef }),
      ...(sourceTemplate.sourceKind === "schedule"
        ? {}
        : { pluginRef: fieldText(sourceTemplate.parameters, "pluginRef") })
    }
  };
}

function requireWorkflowMapping(
  snapshot: LegacyMigrationSourceSnapshot,
  callbackId: string,
  mappings: readonly RegisteredLegacyTriggerWorkflow[]
): RegisteredLegacyTriggerWorkflow {
  const mapping = mappings.find((candidate) =>
    candidate.source.kind === snapshot.ownerKind &&
    candidate.source.id === snapshot.ownerId &&
    candidate.source.definitionRevision === snapshot.definitionRevision &&
    candidate.callbackId === callbackId
  );
  if (mapping === undefined) {
    throw new Error("command.exec requires an Owner-approved versioned workflow");
  }
  return mapping;
}

function compileSourceTemplate(
  snapshot: LegacyMigrationSourceSnapshot,
  plugins: ReturnType<typeof listRegisteredSubscriptionPlugins>
): NonNullable<LegacyTriggerMigrationProposal["candidate"]>["sourceTemplate"] {
  if (snapshot.ownerKind === "schedule") {
    const kind = fieldText(snapshot.source, "kind");
    if (kind !== "once" && kind !== "cron") throw new Error("legacy Schedule kind is unsupported");
    return {
      sourceKind: "schedule",
      templateId: kind === "once" ? "schedule.once@1" : "schedule.cron@1",
      parameters: {
        expression: fieldText(snapshot.source, "expression"),
        ...(kind === "cron"
          ? { timezone: fieldText(snapshot.source, "timezone") }
          : {}),
        misfirePolicy: fieldText(snapshot.source, "misfirePolicy"),
        overlapPolicy: fieldText(snapshot.source, "overlapPolicy"),
        misfireGraceMilliseconds: fieldInteger(
          snapshot.source,
          "misfireGraceMilliseconds"
        ),
        cancellationPolicy: "pause_source"
      }
    };
  }
  const triggerKind = snapshot.ownerKind === "subscription" ? "until" : "continuous";
  const policy = fieldRecord(snapshot.source, "policy");
  const pluginPath = realpathSync(fieldText(snapshot.source, "pluginPath"));
  const pluginId = fieldText(snapshot.source, "pluginId");
  const workspaceRoot = realpathSync(fieldText(policy, "workspaceRoot"));
  const plugin = plugins.find((item) => item.path === pluginPath && item.id === pluginId &&
    item.workspaceRoot === workspaceRoot && item.triggerKinds.includes(triggerKind));
  if (plugin === undefined) {
    throw new Error("legacy probe has no exact Owner-registered replacement Plugin");
  }
  return {
    sourceKind: snapshot.ownerKind,
    templateId: snapshot.ownerKind === "subscription"
      ? "subscription.until@1"
      : "subscription.continuous@1",
    parameters: {
      title: fieldText(snapshot.source, "title"),
      pluginRef: plugin.ref,
      pluginConfig: snapshot.source.pluginConfig,
      intervalMilliseconds: fieldInteger(snapshot.source, "intervalMilliseconds"),
      ...(snapshot.ownerKind === "subscription"
        ? {
            maxWaitMilliseconds: fieldInteger(snapshot.source, "maxWaitMilliseconds"),
            maxAttempts: fieldInteger(snapshot.source, "maxAttempts")
          }
        : {}),
      cancellationPolicy: "pause_source"
    }
  };
}

function assertCandidatePrincipals(database: DatabaseSync, intent: RunIntent): void {
  const steward = database.prepare(`
    SELECT status FROM agents WHERE lower(handle) = 'codex'
  `).get() as { status: string } | undefined;
  if (steward?.status !== "active") throw new Error("active codex Steward is required");
  const agentId = intent.requestedParticipantRefs![0]!.slice("principal:".length);
  const agent = database.prepare(`
    SELECT status FROM agents WHERE principal_id = ?
  `).get(agentId) as { status: string } | undefined;
  if (agent?.status !== "active") throw new Error("legacy target Agent is not active");
}

function assertCandidateDestination(database: DatabaseSync, intent: RunIntent): void {
  if (intent.resultDestinationRef === undefined) return;
  const destinationId = intent.resultDestinationRef.startsWith("destination:")
    ? intent.resultDestinationRef.slice("destination:".length)
    : "";
  if (destinationId === "") {
    throw new Error("legacy workflow result destination ref is unsupported");
  }
  const registered = database.prepare(`
    SELECT 1 AS found FROM deliveries WHERE destination_id = ?
    UNION ALL
    SELECT 1 AS found FROM events, json_each(events.destination_snapshots_json)
    WHERE json_extract(json_each.value, '$.destinationId') = ?
    LIMIT 1
  `).get(destinationId, destinationId) as { found: number } | undefined;
  if (registered === undefined) {
    throw new Error(`Run result destination is not registered: ${destinationId}`);
  }
}

function findApprovedProposal(
  plan: LegacyTriggerMigrationPlan,
  approval: LegacyTriggerMigrationApproval
): LegacyTriggerMigrationProposal {
  const proposal = plan.proposals.find(({ source }) =>
    source.kind === approval.source.kind && source.id === approval.source.id &&
    source.definitionRevision === approval.source.definitionRevision
  );
  if (proposal === undefined) throw new Error("Legacy migration source is not in current inventory");
  if (proposal.proposalDigest !== approval.proposalDigest) {
    throw new Error("Legacy migration proposal digest is stale");
  }
  return proposal;
}

function pauseLegacySource(
  database: DatabaseSync,
  proposal: LegacyTriggerMigrationProposal,
  at: string
): void {
  const source = proposal.source;
  let changes: number;
  if (source.kind === "schedule") {
    changes = Number(database.prepare(`
      UPDATE schedules SET status = 'paused', updated_at = ?
      WHERE schedule_id = ? AND definition_schema = 'ScheduleRevision@1'
        AND current_revision = ? AND status IN ('active', 'paused')
    `).run(at, source.id, Number(source.definitionRevision)).changes);
  } else if (source.kind === "subscription") {
    changes = Number(database.prepare(`
      UPDATE subscriptions SET status = 'paused', updated_at = ?
      WHERE subscription_id = ? AND definition_schema = 'SubscriptionDefinition@3'
        AND definition_revision = ? AND status IN ('active', 'paused')
    `).run(at, source.id, source.definitionRevision).changes);
  } else {
    changes = Number(database.prepare(`
      UPDATE continuous_subscriptions SET status = 'paused', updated_at = ?
      WHERE subscription_id = ?
        AND definition_schema = 'ContinuousSubscriptionDefinition@1'
        AND current_revision = ? AND status IN ('active', 'paused')
    `).run(at, source.id, Number(source.definitionRevision)).changes);
  }
  if (changes !== 1) throw new Error("Legacy migration could not pause the exact source revision");
}

function receiptForExisting(
  proposal: LegacyTriggerMigrationProposal,
  approval: LegacyTriggerMigrationApproval
): LegacyTriggerMigrationReceipt {
  if (proposal.existingReceipt !== undefined) {
    return { ...proposal.existingReceipt, status: "duplicate" };
  }
  const existing = proposal.existingRun!;
  return {
    schemaVersion: "LegacyTriggerMigrationReceipt@1",
    status: "duplicate",
    proposalDigest: approval.proposalDigest,
    source: approval.source,
    oldDefinitionStatus: proposal.source.status,
    newDefinitionStatus: "paused",
    runId: existing.runId,
    admissionDigest: existing.admissionDigest,
    migrationRequestId: proposal.migrationRequestId,
    appliedAt: existing.createdAt
  };
}

function storedMigrationReceipt(
  database: DatabaseSync,
  snapshot: LegacyMigrationSourceSnapshot
): LegacyTriggerMigrationReceipt | undefined {
  if (!tableExists(database, "legacy_trigger_migration_receipts")) return undefined;
  const row = database.prepare(`
    SELECT proposal_digest, migration_request_id, run_id, admission_digest,
      old_definition_status, applied_at
    FROM legacy_trigger_migration_receipts
    WHERE source_kind = ? AND source_id = ? AND definition_revision = ?
  `).get(
    snapshot.ownerKind,
    snapshot.ownerId,
    snapshot.definitionRevision
  ) as {
    proposal_digest: string;
    migration_request_id: string;
    run_id: string;
    admission_digest: string;
    old_definition_status: "active" | "paused";
    applied_at: string;
  } | undefined;
  if (row === undefined) return undefined;
  return {
    schemaVersion: "LegacyTriggerMigrationReceipt@1",
    status: "applied",
    proposalDigest: digestValue(row.proposal_digest, "stored proposalDigest"),
    source: {
      kind: snapshot.ownerKind,
      id: snapshot.ownerId,
      definitionRevision: snapshot.definitionRevision
    },
    oldDefinitionStatus: row.old_definition_status,
    newDefinitionStatus: "paused",
    runId: row.run_id,
    admissionDigest: digestValue(row.admission_digest, "stored admissionDigest"),
    migrationRequestId: row.migration_request_id,
    appliedAt: row.applied_at
  };
}

function recordMigrationReceipt(
  database: DatabaseSync,
  receipt: LegacyTriggerMigrationReceipt
): void {
  database.prepare(`
    INSERT INTO legacy_trigger_migration_receipts (
      source_kind, source_id, definition_revision, proposal_digest,
      migration_request_id, run_id, admission_digest, old_definition_status,
      applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receipt.source.kind,
    receipt.source.id,
    receipt.source.definitionRevision,
    receipt.proposalDigest,
    receipt.migrationRequestId,
    receipt.runId,
    receipt.admissionDigest,
    receipt.oldDefinitionStatus,
    receipt.appliedAt
  );
}

function parseApproval(value: unknown): LegacyTriggerMigrationApproval {
  const input = record(value, "LegacyTriggerMigrationApproval@1");
  exactKeys(input, ["schemaVersion", "proposalDigest", "source"]);
  if (input.schemaVersion !== "LegacyTriggerMigrationApproval@1") {
    throw new Error("LegacyTriggerMigrationApproval@1 is required");
  }
  const source = record(input.source, "approval.source");
  exactKeys(source, ["kind", "id", "definitionRevision"]);
  if (source.kind !== "schedule" && source.kind !== "subscription" &&
    source.kind !== "continuous_subscription") {
    throw new Error("approval.source.kind is unsupported");
  }
  return {
    schemaVersion: "LegacyTriggerMigrationApproval@1",
    proposalDigest: digestValue(input.proposalDigest, "proposalDigest"),
    source: {
      kind: source.kind,
      id: fieldText(source, "id"),
      definitionRevision: fieldText(source, "definitionRevision")
    }
  };
}

function migrationRequest(snapshot: LegacyMigrationSourceSnapshot): string {
  return `legacy-migration:${createHash("sha256").update([
    snapshot.ownerKind,
    snapshot.ownerId,
    snapshot.definitionRevision
  ].join("\0")).digest("hex")}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableContractJson(value)).digest("hex")}`;
}

function digestValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be a sha256 digest`);
  }
  return value;
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  const extra = actual.find((key) => !keys.includes(key));
  const missing = keys.find((key) => value[key] === undefined);
  if (extra !== undefined) throw new Error(`unsupported field: ${extra}`);
  if (missing !== undefined) throw new Error(`missing field: ${missing}`);
}

function fieldText(value: Readonly<Record<string, unknown>>, field: string): string {
  const item = value[field];
  if (typeof item !== "string" || item.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return item;
}

function fieldInteger(value: Readonly<Record<string, unknown>>, field: string): number {
  const item = value[field];
  if (!Number.isInteger(item)) throw new Error(`${field} must be an integer`);
  return item as number;
}

function fieldRecord(
  value: Readonly<Record<string, unknown>>,
  field: string
): Readonly<Record<string, unknown>> {
  return record(value[field], field);
}

function fieldStrings(
  value: Readonly<Record<string, unknown>>,
  field: string
): readonly string[] {
  const item = value[field];
  if (!Array.isArray(item) || item.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return item as string[];
}
