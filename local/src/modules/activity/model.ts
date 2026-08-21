import type { AgentClient } from "../agent/client-profile.js";

export type ActivitySourceId = "rollerskate" | AgentClient;

export interface ActivityRecord {
  readonly source: ActivitySourceId;
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly reference: string;
}

export interface ActivitySourceCoverage {
  readonly source: ActivitySourceId;
  readonly state: "available" | "unavailable" | "unsupported";
  readonly detail: string;
}

export interface ActivityQueryResult {
  readonly scope: "agent" | "owner-wide";
  readonly records: readonly ActivityRecord[];
  readonly coverage: readonly ActivitySourceCoverage[];
  readonly truncated: boolean;
}
