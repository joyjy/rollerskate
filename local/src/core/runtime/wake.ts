import { realpathSync } from "node:fs";
import { resolve } from "node:path";

type RuntimeWorkListener = () => void;

const listenersByDatabase = new Map<string, Set<RuntimeWorkListener>>();

export function subscribeRuntimeWork(
  databasePath: string,
  listener: RuntimeWorkListener
): () => void {
  const key = canonicalDatabasePath(databasePath);
  const listeners = listenersByDatabase.get(key) ?? new Set<RuntimeWorkListener>();
  listeners.add(listener);
  listenersByDatabase.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByDatabase.delete(key);
  };
}

export function notifyRuntimeWork(databasePath: string | undefined): void {
  if (databasePath === undefined) return;
  for (const listener of listenersByDatabase.get(canonicalDatabasePath(databasePath)) ?? []) {
    listener();
  }
}

function canonicalDatabasePath(databasePath: string): string {
  const absolutePath = resolve(databasePath);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}
