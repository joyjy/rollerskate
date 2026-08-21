import type { RuntimeStore } from "../../core/runtime/store.js";

export function reconcileInterruptedCallbacks<Group>(input: {
  readonly runtime: RuntimeStore;
  readonly groups: readonly Group[];
  readonly eventIds: (group: Group) => readonly string[];
  readonly markUnknown: (group: Group) => number;
  readonly reason: string;
  readonly at: string;
}): number {
  let changed = 0;
  for (const group of input.groups) {
    input.runtime.failExecutionsForEventsInTransaction(
      input.eventIds(group),
      input.reason,
      input.at
    );
    changed += input.markUnknown(group);
  }
  return changed;
}
