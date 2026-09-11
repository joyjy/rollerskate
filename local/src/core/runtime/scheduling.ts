import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { RuntimeExecution, RuntimeHandlerKind } from "./model.js";

export const executionLimits = Object.freeze({ agent: 4, perAgent: 2, result: 2, chat: 1 });

export interface ExecutionResources {
  readonly agentId?: string;
  readonly lanes: readonly string[];
  readonly workspace?: { readonly root: string; readonly access: "read" | "write" };
}
export interface SchedulingEntry {
  readonly execution: RuntimeExecution;
  readonly resources: ExecutionResources;
}

export function canonicalWorkspace(root: string): string {
  try { return realpathSync(root); } catch { return resolve(root); }
}
function overlaps(left: string, right: string): boolean {
  const contains = (a: string, b: string) => {
    const path = relative(a, b);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
  };
  return contains(left, right) || contains(right, left);
}
function conflicts(left: ExecutionResources, right: ExecutionResources): boolean {
  if (left.lanes.some(lane => right.lanes.includes(lane))) return true;
  return left.workspace !== undefined && right.workspace !== undefined &&
    (left.workspace.access === "write" || right.workspace.access === "write") &&
    overlaps(left.workspace.root, right.workspace.root);
}

// The cursor is a disposable fairness hint. Capacity/leases come from SQLite on each selection.
export class ExecutionScheduler {
  #lastAgent: string | undefined;
  #lastLaneByAgent = new Map<string, string>();

  public select(
    due: readonly SchedulingEntry[],
    running: readonly SchedulingEntry[],
    resultBarriers: readonly SchedulingEntry[],
    limit: number,
    advance = true
  ): RuntimeExecution[] {
    // Canonicalize each distinct path once per snapshot, not once per queued Event.
    const roots = new Map<string, string>();
    const normalize = (item: SchedulingEntry): SchedulingEntry => {
      const workspace = item.resources.workspace;
      if (workspace === undefined) return item;
      if (!roots.has(workspace.root)) roots.set(workspace.root, canonicalWorkspace(workspace.root));
      return { ...item, resources: { ...item.resources, workspace: { ...workspace, root: roots.get(workspace.root)! } } };
    };
    due = due.map(normalize); running = running.map(normalize); resultBarriers = resultBarriers.map(normalize);
    const counts: Record<RuntimeHandlerKind, number> = { agent: 0, result: 0, chat: 0 };
    const perAgent = new Map<string, number>();
    const occupied = [...running, ...resultBarriers];
    for (const item of running) {
      counts[item.execution.handler]++;
      if (item.execution.handler === "agent" && item.resources.agentId !== undefined) {
        const id = item.resources.agentId;
        perAgent.set(id, (perAgent.get(id) ?? 0) + 1);
      }
    }
    const selected: RuntimeExecution[] = [];
    const accept = (item: SchedulingEntry): boolean => {
      const { execution, resources } = item;
      const kind = execution.handler;
      if (selected.length >= limit || counts[kind] >= executionLimits[kind]) return false;
      if (kind === "agent" && (perAgent.get(resources.agentId ?? "") ?? 0) >= executionLimits.perAgent) return false;
      // Result consumption must not wait on its own workspace barrier.
      if (kind === "agent" && occupied.some(other => other.execution.executionId !== execution.executionId &&
        conflicts(resources, other.resources))) return false;
      if (kind === "agent" && due.slice(0, due.indexOf(item)).some(earlier =>
        earlier.execution.handler === "agent" && earlier.resources.workspace !== undefined && resources.workspace !== undefined &&
        (earlier.resources.workspace.access === "write" || resources.workspace.access === "write") &&
        overlaps(earlier.resources.workspace.root, resources.workspace.root) &&
        !selected.some(row => row.executionId === earlier.execution.executionId))) return false;
      selected.push(execution);
      counts[kind]++;
      if (kind === "agent") perAgent.set(resources.agentId!, (perAgent.get(resources.agentId!) ?? 0) + 1);
      occupied.push(item);
      return true;
    };
    for (const item of due.filter(item => item.execution.handler !== "agent")) accept(item);
    const groups = new Map<string, SchedulingEntry[]>();
    for (const item of due.filter(item => item.execution.handler === "agent")) {
      const id = item.resources.agentId!;
      const rows = groups.get(id) ?? [];
      rows.push(item); groups.set(id, rows);
    }
    const agents = rotate([...groups.keys()], this.#lastAgent);
    const seenLanes = new Set<string>();
    const queues = new Map(agents.map(id => {
      const heads = groups.get(id)!.filter(item => {
        const key = item.resources.lanes[0]!;
        if (seenLanes.has(key)) return false;
        seenLanes.add(key); return true;
      });
      const laneIds = rotate(heads.map(item => item.resources.lanes[0]!), this.#lastLaneByAgent.get(id));
      const byLane = new Map(heads.map(item => [item.resources.lanes[0]!, item]));
      return [id, laneIds.map(key => byLane.get(key)!)] as const;
    }));
    // One turn per Agent per sweep; skip blocked lanes, keep FIFO inside each lane.
    while (selected.length < limit && counts.agent < executionLimits.agent) {
      let progress = false;
      for (const id of agents) {
        const rows = queues.get(id)!;
        while (rows.length) {
          const item = rows.shift()!;
          if (!accept(item)) continue;
          if (advance) { this.#lastAgent = id; this.#lastLaneByAgent.set(id, item.resources.lanes[0]!); }
          progress = true; break;
        }
      }
      if (!progress) break;
    }
    if (advance) for (const id of this.#lastLaneByAgent.keys()) {
      if (!groups.has(id)) this.#lastLaneByAgent.delete(id);
    }
    return selected;
  }
}
function rotate<T>(values: T[], previous: T | undefined): T[] {
  const index = previous === undefined ? -1 : values.indexOf(previous);
  return index < 0 ? values : [...values.slice(index + 1), ...values.slice(0, index + 1)];
}
