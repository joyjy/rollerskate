import type {
  AgentWorkRequest,
  AgentWorkRequestDecisionReceipt
} from "../../protocol.js";
import { AgentCredentialStore } from
  "../../infrastructure/files/agent-credential-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { LocalFoundationStore } from
  "../../infrastructure/sqlite/foundation-store.js";
import { AgentServerClient } from "../../integrations/server/agent-client.js";
import { startStewardRun, type StartStewardRunReceipt } from "../steward/control.js";

const POLICY_REVISION = 1;
const MAX_STEPS = 20;
const MAX_DEPTH = 4;

export type WorkRequestOwnerDecision = "awaiting-owner" | "accepted" | "rejected";

export interface DecideWorkRequestInput {
  readonly agentHandle: string;
  readonly workRequestId: string;
  readonly expectedRevision: number;
  readonly decision: WorkRequestOwnerDecision;
}

export interface WorkRequestTarget {
  readonly serverAgentId: string;
  readonly localAgentId: string;
  readonly handle: string;
  readonly client: Pick<AgentServerClient,
    "registerWorkRequestRoute" | "routedWorkRequests" | "acceptedWorkRequestsWithoutRun" |
    "workRequest" | "decideWorkRequest" | "attachWorkRequestRun" | "completeWorkRequest">;
}

export interface WorkRequestControlDependencies {
  readonly runtimeDirectory?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export async function decideWorkRequest(
  repoRoot: string,
  input: DecideWorkRequestInput,
  dependencies: WorkRequestControlDependencies = {}
): Promise<{ readonly request: AgentWorkRequest; readonly run?: StartStewardRunReceipt }> {
  const target = workRequestTargetForHandle(repoRoot, input.agentHandle, dependencies);
  return decideWorkRequestForTarget(repoRoot, input, target, dependencies);
}

export async function inspectWorkRequest(
  repoRoot: string,
  agentHandle: string,
  workRequestId: string,
  dependencies: WorkRequestControlDependencies = {}
): Promise<AgentWorkRequest> {
  return workRequestTargetForHandle(repoRoot, agentHandle, dependencies)
    .client.workRequest(workRequestId);
}

export async function decideWorkRequestForTarget(
  repoRoot: string,
  input: DecideWorkRequestInput,
  target: WorkRequestTarget,
  dependencies: WorkRequestControlDependencies = {}
): Promise<{ readonly request: AgentWorkRequest; readonly run?: StartStewardRunReceipt }> {
  const current = await target.client.workRequest(input.workRequestId);
  const decided = current.decisionReceipt?.decision === input.decision
    ? current
    : await target.client.decideWorkRequest(input.workRequestId, {
        schemaVersion: "AgentWorkRequestDecision@1",
        expectedRevision: input.expectedRevision,
        receipt: decisionReceipt(current, input.decision,
          (dependencies.now ?? (() => new Date()))().toISOString())
      });
  if (decided.status !== "accepted") return { request: decided };
  return attachAcceptedWorkRequest(repoRoot, target, decided, dependencies);
}

export async function attachAcceptedWorkRequest(
  repoRoot: string,
  target: WorkRequestTarget,
  request: AgentWorkRequest,
  dependencies: WorkRequestControlDependencies = {}
): Promise<{ readonly request: AgentWorkRequest; readonly run: StartStewardRunReceipt }> {
  if (request.status !== "accepted" || request.decisionReceipt?.decision !== "accepted") {
    throw new Error("Only an accepted work request can create a Local Run");
  }
  const admission = request.decisionReceipt;
  if (admission.admittedWorkflowRef === undefined ||
    admission.admittedBudget === undefined || admission.admittedGrantRefs === undefined) {
    throw new Error("Accepted work request is missing its exact admission receipt");
  }
  const workflowRef = admission.admittedWorkflowRef;
  const budget = admission.admittedBudget;
  const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const run = startStewardRun(repoRoot, {
    requestId: `work-request:${request.workRequestId}`,
    steward: target.handle,
    workflowRef,
    inputs: {
      objective: request.objective,
      workRequestAdmission: {
        schemaVersion: "AgentWorkRequestAdmission@1",
        workRequestId: request.workRequestId,
        requesterRef: request.requesterRef,
        targetServerAgentId: target.serverAgentId,
        contextRefs: request.contextRefs,
        resultRoute: request.resultRoute,
        decisionReceipt: admission
      }
    },
    maxSteps: budget.maxSteps,
    maxDepth: budget.maxDepth,
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
    participantAgentIds: [target.localAgentId]
  }, dependencies.runtimeDirectory, startedAt);
  const attached = await target.client.attachWorkRequestRun(request.workRequestId, {
    schemaVersion: "AgentWorkRequestRunAttach@1",
    expectedRevision: request.revision,
    receipt: {
      schemaVersion: "AgentWorkRequestRunReceipt@1",
      runId: run.run.runId,
      admittedAt: run.run.createdAt
    }
  });
  return { request: attached, run };
}

export function listWorkRequestTargets(
  repoRoot: string,
  dependencies: WorkRequestControlDependencies = {}
): readonly WorkRequestTarget[] {
  const paths = runtimePaths(repoRoot, dependencies.runtimeDirectory);
  const foundation = new LocalFoundationStore(paths.database);
  const credentials = new AgentCredentialStore(paths.agentCredentials);
  try {
    return foundation.listAgents().filter((agent) => agent.status === "active").flatMap((agent) => {
      const credential = credentials.load(agent.handle);
      if (credential?.state !== "active") return [];
      return [{
        serverAgentId: credential.agentId,
        localAgentId: agent.principalId,
        handle: agent.handle,
        client: new AgentServerClient({
          serverUrl: credential.serverUrl,
          agentId: credential.agentId,
          credential: credential.credential,
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
        })
      }];
    });
  } finally {
    foundation.close();
  }
}

function workRequestTargetForHandle(
  repoRoot: string,
  handle: string,
  dependencies: WorkRequestControlDependencies
): WorkRequestTarget {
  const target = listWorkRequestTargets(repoRoot, dependencies)
    .find((candidate) => candidate.handle === handle);
  if (target === undefined) {
    throw new Error(`Active paired Agent not found: ${handle}`);
  }
  return target;
}

function decisionReceipt(
  request: AgentWorkRequest,
  decision: WorkRequestOwnerDecision,
  decidedAt: string
): AgentWorkRequestDecisionReceipt {
  if (decision !== "accepted") {
    return {
      schemaVersion: "AgentWorkRequestDecisionReceipt@1",
      decision,
      policyRevision: POLICY_REVISION,
      statusReason: decision === "rejected"
        ? "owner-explicit-rejection"
        : "owner-review-required",
      decidedAt
    };
  }
  const requested = request.requestedBudget;
  return {
    schemaVersion: "AgentWorkRequestDecisionReceipt@1",
    decision,
    policyRevision: POLICY_REVISION,
    statusReason: "owner-explicit-acceptance",
    admittedWorkflowRef: request.workflowRef ?? "forum@1",
    admittedBudget: {
      maxSteps: Math.min(requested?.maxSteps ?? MAX_STEPS, MAX_STEPS),
      maxDepth: Math.min(requested?.maxDepth ?? MAX_DEPTH, MAX_DEPTH)
    },
    admittedGrantRefs: [],
    decidedAt
  };
}
