import {createHash} from "node:crypto";
import type {PollObservation} from "./plugin-contract.js";

/** Bounded coordination state, not a copy of tool output or a second business lifecycle. */
export interface ObservationState {
  readonly schemaVersion: "ObservationState@1";
  readonly checkpointMilliseconds: number;
  readonly sourceDigest: string;
  readonly lastQueryAt?: string;
  readonly lastSuccessfulQueryAt?: string;
  readonly sourceAvailability: "unknown" | "available" | "unavailable";
  readonly businessState: "unknown" | "running" | "success" | "failure" | "cancelled";
  readonly progressDigest?: string;
  readonly lastProgressAt?: string;
  readonly checkpointIndex: number;
  readonly lastNoticeAt?: string;
  readonly lastSourceNoticeAt?: string;
  readonly lastNoticeReceiptId?: string;
}

export function initialObservationState(checkpointMilliseconds: number, maxWaitMilliseconds: number, sourceDigest: string): ObservationState {
  if (!Number.isSafeInteger(checkpointMilliseconds) || checkpointMilliseconds < 1000 || checkpointMilliseconds > maxWaitMilliseconds) {
    throw new Error("checkpointMilliseconds must be an integer within the total wait budget");
  }
  return {schemaVersion:"ObservationState@1", checkpointMilliseconds, sourceDigest,
    sourceAvailability:"unknown", businessState:"unknown", checkpointIndex:0};
}

export function parseObservationState(text: string): ObservationState {
  if (Buffer.byteLength(text) > 16384) throw new Error("Observation state exceeds limit");
  const state = JSON.parse(text) as ObservationState;
  if (state.schemaVersion !== "ObservationState@1" || !Number.isSafeInteger(state.checkpointMilliseconds) || state.checkpointMilliseconds < 1000 ||
    !Number.isSafeInteger(state.checkpointIndex) || state.checkpointIndex < 0 || !/^[A-Za-z0-9_-]{43}$/u.test(state.sourceDigest) ||
    !["unknown","available","unavailable"].includes(state.sourceAvailability) ||
    !["unknown","running","success","failure","cancelled"].includes(state.businessState)) throw new Error("Invalid observation state");
  for (const at of [state.lastQueryAt,state.lastSuccessfulQueryAt,state.lastProgressAt,state.lastNoticeAt,state.lastSourceNoticeAt]) {
    if (at !== undefined && (typeof at !== "string" || !Number.isFinite(Date.parse(at)))) throw new Error("Invalid observation timestamp");
  }
  return state;
}

export function advanceObservation(state: ObservationState, startedAt: string, at: string, observation?: PollObservation): {
  state: ObservationState; notice: "checkpoint" | "progress" | "source_unavailable" | "source_recovered" | null;
} {
  const index = Math.max(0, Math.floor((Date.parse(at) - Date.parse(startedAt)) / state.checkpointMilliseconds));
  // Hash source-owned facts; SQLite retains no raw output or credentials.
  const digest = observation === undefined ? undefined : `sha256:${createHash("sha256").update(JSON.stringify({version:observation.version,facts:observation.facts})).digest("hex")}`;
  const changed = digest !== undefined && digest !== state.progressDigest;
  const availability = observation === undefined ? "unavailable" : "available";
  // First source failure is immediate; subsequent transitions and progress are bounded.
  const canNotifyProgress = state.lastNoticeAt === undefined || Date.parse(at) - Date.parse(state.lastNoticeAt) >= state.checkpointMilliseconds;
  const canNotifySource = state.lastSourceNoticeAt === undefined || Date.parse(at) - Date.parse(state.lastSourceNoticeAt) >= state.checkpointMilliseconds;
  const notice = availability !== state.sourceAvailability && canNotifySource && (state.sourceAvailability !== "unknown" || availability === "unavailable")
    ? availability === "unavailable" ? "source_unavailable" : "source_recovered"
    : index > state.checkpointIndex ? "checkpoint"
    : changed && state.progressDigest !== undefined && canNotifyProgress ? "progress" : null;
  return {state:{...state,lastQueryAt:at,sourceAvailability:availability,
    businessState:observation === undefined ? "unknown" : observation.terminal ?? "running",
    ...(observation === undefined ? {} : {lastSuccessfulQueryAt:at,progressDigest:digest!,
      ...(changed ? {lastProgressAt:at} : {})}), checkpointIndex:index},notice};
}
