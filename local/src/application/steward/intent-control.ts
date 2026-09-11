import type { DatabaseSync } from "node:sqlite";

import type { RunIntent, StewardRunRequest } from
  "../../modules/steward/admission-contract.js";
import type { StartStewardRunReceipt } from "./control.js";
import {
  startStewardRun,
  startStewardRunInTransaction,
  type StartStewardRunInput
} from "./control.js";
import {
  compileRunIntent,
  compileRunIntentWithOwnerPolicy,
  type RunIntentOwnerPolicy
} from "./admission.js";

export interface StartStewardRunFromIntentReceipt extends StartStewardRunReceipt {
  readonly admission: StewardRunRequest;
}

export function preflightStewardRunIntent(
  repoRoot: string,
  input: RunIntent | unknown,
  runtimeDirectory?: string
): StewardRunRequest {
  return compileRunIntent(repoRoot, input, runtimeDirectory);
}

export function startStewardRunFromIntent(
  repoRoot: string,
  input: RunIntent | unknown,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): StartStewardRunFromIntentReceipt {
  const admission = compileRunIntent(repoRoot, input, runtimeDirectory);
  return startFromAdmission(repoRoot, admission, runtimeDirectory, at);
}

export function startStewardRunFromOwnerIntent(
  repoRoot: string,
  input: RunIntent | unknown,
  policy: RunIntentOwnerPolicy,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): StartStewardRunFromIntentReceipt {
  const admission = compileRunIntentWithOwnerPolicy(
    repoRoot,
    input,
    policy,
    runtimeDirectory
  );
  return startFromAdmission(repoRoot, admission, runtimeDirectory, at);
}

function startFromAdmission(
  repoRoot: string,
  admission: StewardRunRequest,
  runtimeDirectory: string | undefined,
  at: string
): StartStewardRunFromIntentReceipt {
  const result = startStewardRun(
    repoRoot,
    startInputFromAdmission(admission),
    runtimeDirectory,
    at
  );
  return { ...result, admission };
}

export function startStewardRunFromAdmissionInTransaction(
  admission: StewardRunRequest,
  database: DatabaseSync,
  at = new Date().toISOString()
): StartStewardRunFromIntentReceipt {
  const result = startStewardRunInTransaction(
    startInputFromAdmission(admission),
    database,
    at
  );
  return { ...result, admission };
}

function startInputFromAdmission(admission: StewardRunRequest): StartStewardRunInput {
  return {
    requestId: admission.idempotencyKey,
    steward: admission.stewardSelection?.agentId ?? "codex",
    ...(admission.mandate.kind === "objective"
      ? { objective: renderIntentMandate(admission) }
      : {
          workflowRef: admission.mandate.workflowRef,
          inputs: admission.mandate.inputs
        }),
    ...(admission.authority.workspace === undefined
      ? {}
      : {
          workspace: admission.authority.workspace.access === "read"
            ? {
                root: admission.authority.workspace.root,
                access: "read" as const,
                networkAccess: admission.authority.workspace.networkAccess,
                expectedRevision: admission.authority.workspace.revision
              }
            : {
                root: admission.authority.workspace.root,
                access: "write" as const,
                effect: admission.authority.workspace.effect!,
                networkAccess: admission.authority.workspace.networkAccess,
                expectedRevision: admission.authority.workspace.revision
              }
        }),
    maxSteps: admission.authority.maxSteps,
    maxDepth: admission.authority.maxDepth,
    ...(admission.authority.deadlineAt === undefined
      ? {}
      : { deadlineAt: admission.authority.deadlineAt }),
    participantAgentIds: admission.authority.participantAgentIds,
    orchestration: {
      mode: "steward",
      admission: {
        digest: admission.admissionDigest,
        ...(admission.acceptanceContract === undefined ? {} : {acceptanceContract: admission.acceptanceContract}),
        ...(admission.ownerNetworkAuthorized === true ? {ownerNetworkAuthorized: true} : {}),
        ...(admission.stewardSelection === undefined ? {} : { selection: admission.stewardSelection }),
        authority: admission.authority
      }
    },
    ...(admission.resultDestination === undefined
      ? {}
      : { resultDestination: admission.resultDestination })
  };
}

function renderIntentMandate(request: StewardRunRequest): string {
  return [
    request.objective,
    "",
    "Original acceptance (dispatch notes cannot weaken these requirements):",
    ...request.acceptance.map((item, index) => `- a${index + 1}: ${item}`),
    ...(request.dispatchNotes === undefined ? [] : ["Dispatch notes (execution advice only):", request.dispatchNotes]),
    "",
    "Terminal evidence:",
    ...request.terminalEvidence.map((item) => `- ${item}`),
    ...(request.contextRefs.length === 0
      ? []
      : ["", "Context references:", ...request.contextRefs.map((item) => `- ${item}`)]),
    "",
    `Admission: ${request.authoritySummary}`
  ].join("\n");
}
