import {
  eventTrace,
  listEventTraces
} from "../event/query.js";

/** @deprecated Use eventTrace from application/event/query. */
export function runtimeTrace(
  repoRoot: string,
  eventId: string,
  runtimeDirectory?: string
): unknown {
  return eventTrace(repoRoot, eventId, runtimeDirectory);
}

/** @deprecated Use listEventTraces from application/event/query. */
export function runtimeTraces(
  repoRoot: string,
  runtimeDirectory?: string
): unknown[] {
  return [...listEventTraces(repoRoot, runtimeDirectory)];
}
