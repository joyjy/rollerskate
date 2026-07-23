import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { runtimePaths } from "./runtime-config.js";
import { PollSubscriptionStore } from "../capabilities/subscription/store.js";
import { readLoopStatus, type LoopStatus } from "../core/loop.js";
import { RuntimeStore } from "../core/runtime/store.js";
import { LoopControlStore } from "./loop-control-store.js";

export interface RuntimeActivity {
  readonly events: number;
  readonly executions: Readonly<Record<string, number>>;
  readonly resultEvents: Readonly<Record<string, number>>;
  readonly deliveries: Readonly<Record<string, number>>;
  readonly sessions: number;
}

export interface RuntimeStatus extends LoopStatus {
  readonly activity?: RuntimeActivity;
}

export function runtimeStatus(
  repoRoot: string,
  runtimeDirectory?: string
): RuntimeStatus {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const status = readLoopStatus(paths.loopState);
  const activity = readActivity(paths.database);
  return {
    ...status,
    ...(activity === undefined ? {} : { activity })
  };
}

export function reconcileRuntime(
  repoRoot: string,
  runtimeDirectory?: string
): number {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const subscriptions = new PollSubscriptionStore(paths.database);
  const runtime = new RuntimeStore(paths.database);
  try {
    return runtime.reconcileInterrupted() + subscriptions.reconcileInterrupted();
  } finally {
    runtime.close();
    subscriptions.close();
  }
}

export function setLoopPaused(
  repoRoot: string,
  paused: boolean,
  runtimeDirectory?: string
): void {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.runtimeDirectory, 0o700);
  new LoopControlStore(paths.loopControl).setPaused(paused);
}

function readActivity(databasePath: string): RuntimeActivity | undefined {
  if (!existsSync(databasePath)) return undefined;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    if (["events", "executions", "deliveries", "sessions"].some((table) => !tables.has(table))) {
      return undefined;
    }
    const eventColumns = new Set((database.prepare("PRAGMA table_info(events)").all() as unknown as
      Array<{ name: string }>).map((row) => row.name));
    if (!eventColumns.has("outcome")) return undefined;
    return {
      events: (database.prepare("SELECT COUNT(*) AS count FROM events")
        .get() as { count: number }).count,
      executions: grouped(database, "executions"),
      resultEvents: Object.fromEntries((database.prepare(`
        SELECT outcome, COUNT(*) AS count FROM events
        WHERE type = 'agent.result' GROUP BY outcome ORDER BY outcome
      `).all() as unknown as Array<{ outcome: string; count: number }>).map((row) => [
        row.outcome,
        row.count
      ])),
      deliveries: grouped(database, "deliveries"),
      sessions: (database.prepare("SELECT COUNT(*) AS count FROM sessions")
        .get() as { count: number }).count
    };
  } finally {
    database.close();
  }
}

function grouped(database: DatabaseSync, table: string): Readonly<Record<string, number>> {
  return Object.fromEntries((database.prepare(
    `SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status ORDER BY status`
  ).all() as unknown as Array<{ status: string; count: number }>).map((row) => [
    row.status,
    row.count
  ]));
}
