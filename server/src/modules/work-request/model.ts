import type { AgentWorkRequest } from "@rollerskate/protocol";

export interface AgentWorkRequestRecord {
  readonly value: AgentWorkRequest;
  readonly requestDigest: string;
  readonly targetRouteId?: string;
}
