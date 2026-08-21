import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  runtimePaths,
  setupLocalRuntime,
  type SetupInput
} from "../../infrastructure/runtime/config.js";
import { SubscriptionStore } from "../../capabilities/subscription/store.js";
import { CallbackStore } from "../../infrastructure/callback/store.js";
import { ScheduledTaskStore } from "../../capabilities/scheduled-task/store.js";
import { readLoopStatus, type LoopStatus } from "../../core/loop.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { LoopControlStore } from "../../infrastructure/files/loop-control-store.js";
import { assertRuntimeSchemaUpgradeAllowed as assertSchemaUpgradeAllowed } from
  "../../infrastructure/sqlite/schema.js";
import {
  runtimeOperationsView,
  type RuntimeControlResultView
} from "./query.js";

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

export type { SetupInput };

export type RuntimeControlAction = "pause" | "resume" | "recover";

export function assertRuntimeSchemaUpgradeAllowed(
  repoRoot: string,
  runtimeDirectory?: string
): void {
  assertSchemaUpgradeAllowed(runtimePaths(repoRoot, runtimeDirectory).database);
}

export function setupRuntime(
  repoRoot: string,
  input: SetupInput,
  at: string,
  runtimeDirectory?: string
) {
  return setupLocalRuntime(repoRoot, input, at, runtimeDirectory);
}

export function runtimeLogPaths(
  repoRoot: string,
  runtimeDirectory?: string
): {
  readonly logs: string;
  readonly daemonLog: string;
} {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  return { logs: paths.logs, daemonLog: paths.daemonLog };
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
  const callbacks = new CallbackStore(paths.database);
  const subscriptions = new SubscriptionStore(paths.database);
  const schedules = new ScheduledTaskStore(paths.database);
  const runtime = new RuntimeStore(paths.database);
  try {
    const recovered = schedules.reconcileInterrupted() +
      runtime.reconcileInterrupted() +
      callbacks.reconcileInterrupted();
    subscriptions.reconcileCallbacks();
    return recovered;
  } finally {
    subscriptions.close();
    runtime.close();
    schedules.close();
    callbacks.close();
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

export function controlRuntime(
  repoRoot: string,
  action: RuntimeControlAction,
  runtimeDirectory?: string
): RuntimeControlResultView {
  const current = runtimeOperationsView(repoRoot, runtimeDirectory, "");
  if (!current.controls[action]) {
    throw new Error(`Runtime cannot ${action} while status is ${current.status}`);
  }
  if (action === "recover") {
    const recovered = reconcileRuntime(repoRoot, runtimeDirectory);
    return {
      kind: "recover",
      status: "succeeded",
      message: `Reconciled ${recovered} interrupted item(s).`,
      recovered,
      leftUnknown: 0,
      failed: 0
    };
  }
  setLoopPaused(repoRoot, action === "pause", runtimeDirectory);
  return {
    kind: action,
    status: "succeeded",
    message: action === "pause"
      ? "Durable pause requested; in-flight provider calls may still finish."
      : "Durable pause cleared; the next loop cycle may claim work."
  };
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
      sessions: (database.prepare("SELECT COUNT(*) AS count FROM agent_sessions")
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
