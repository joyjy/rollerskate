import { ActivityAccessStore, type ActivityAccessGrant } from
  "../../infrastructure/files/activity-access-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { listAgents, type LocalControlOptions } from "../agent/control.js";

export function grantOwnerWideActivityAccess(
  repoRoot: string,
  agentHandle: string,
  options: LocalControlOptions = {}
): ActivityAccessGrant {
  const agent = requireAgent(repoRoot, agentHandle, options);
  if (agent.status !== "active") throw new Error("Activity access requires an active Agent");
  return store(repoRoot, options).grant(agent.principalId, timestamp(options));
}

export function inspectActivityAccess(
  repoRoot: string,
  agentHandle: string,
  options: LocalControlOptions = {}
): ActivityAccessGrant | undefined {
  const agent = requireAgent(repoRoot, agentHandle, options);
  return store(repoRoot, options).inspect(agent.principalId);
}

export function revokeOwnerWideActivityAccess(
  repoRoot: string,
  agentHandle: string,
  options: LocalControlOptions = {}
): ActivityAccessGrant | undefined {
  const agent = requireAgent(repoRoot, agentHandle, options);
  return store(repoRoot, options).revoke(agent.principalId, timestamp(options));
}

function requireAgent(repoRoot: string, handle: string, options: LocalControlOptions) {
  const key = handle.trim().toLocaleLowerCase("und");
  const agent = listAgents(repoRoot, options).find((candidate) =>
    candidate.handle.toLocaleLowerCase("und") === key);
  if (agent === undefined) throw new Error(`Local Agent not found: ${handle}`);
  return agent;
}

function store(repoRoot: string, options: LocalControlOptions): ActivityAccessStore {
  return new ActivityAccessStore(runtimePaths(repoRoot, options.runtimeDirectory).activityAccess);
}

function timestamp(options: LocalControlOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}
