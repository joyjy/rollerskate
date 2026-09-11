import { FileEventListener } from "./file-source.js";
import type { FileEventSource } from "./file-source.js";
import type { ContinuousSubscriptionStore } from "./continuous-store.js";

/** A source adapter driven exclusively by ContinuousSubscriptionRuntime.runCycle. */
export class FileSubscriptionSources {
  readonly #listeners = new Map<string, FileEventListener>();
  readonly #eligible = new Set<string>();
  readonly #retryAt = new Map<string, number>();
  readonly #create: (source: FileEventSource) => FileEventListener;
  public constructor(create = (source: FileEventSource): FileEventListener => new FileEventListener(source)) {
    this.#create = create;
  }

  public runCycle(store: ContinuousSubscriptionStore, signal: AbortSignal, at: string): { deltas: string[]; failed: string[] } {
    this.#eligible.clear();
    const result = { deltas: [] as string[], failed: [] as string[] };
    const subscriptions = store.fileSubscriptions();
    const active = new Set(subscriptions.filter((item) => item.status === "active").map((item) => item.subscriptionId));
    for (const [id, listener] of this.#listeners) {
      if (signal.aborted || !active.has(id)) {
        listener.close();
        this.#listeners.delete(id);
        this.#retryAt.delete(id);
        store.recordFileListener(id, { status: "stopped", observedAt: at });
      }
    }
    for (const id of this.#retryAt.keys()) if (!active.has(id)) this.#retryAt.delete(id);
    if (signal.aborted) return result;
    for (const subscription of subscriptions) {
      const id = subscription.subscriptionId;
      if (subscription.status !== "active" || subscription.definition.schemaVersion !== "ContinuousSubscriptionDefinition@4") continue;
      if ((this.#retryAt.get(id) ?? 0) > Date.parse(at)) continue;
      try {
        let listener = this.#listeners.get(id);
        if (listener?.error !== undefined) throw new Error(listener.error);
        if (listener === undefined) {
          listener = this.#create(subscription.definition.source);
          this.#listeners.set(id, listener);
        }
        store.recordFileListener(id, { status: "watching", observedAt: at });
        this.#retryAt.delete(id);
        if (subscription.pendingOccurrenceKey !== undefined) continue;
        this.#eligible.add(id);
        const key = listener.due(Date.parse(at));
        if (key === undefined) continue;
        store.recordObservation(id, {
          version: "FileSourceObservation@1", occurrenceKey: key, terminal: null,
          facts: { root: subscription.definition.source.root, reconcile: true },
          summary: "Reconcile file source scope after native notification or listener startup"
        }, at);
        listener.accepted(key);
        result.deltas.push(id);
      } catch (error) {
        this.#listeners.get(id)?.close();
        this.#listeners.delete(id);
        this.#retryAt.set(id, Date.parse(at) + 1_000);
        store.recordFileListener(id, { status: "degraded", observedAt: at,
          error: String(error instanceof Error ? error.message : error).slice(0, 4096) });
        result.failed.push(id);
      }
    }
    return result;
  }

  public nextWaitMilliseconds(maximum: number): number {
    let wait = maximum;
    for (const id of this.#eligible) wait = this.#listeners.get(id)?.nextWaitMilliseconds(wait) ?? wait;
    for (const retryAt of this.#retryAt.values()) wait = Math.min(wait, Math.max(0, retryAt - Date.now()));
    return wait;
  }

  public close(store?: ContinuousSubscriptionStore): void {
    const ids = [...this.#listeners.keys()];
    for (const listener of this.#listeners.values()) listener.close();
    this.#listeners.clear();
    this.#retryAt.clear();
    this.#eligible.clear();
    // Release every native resource before attempting diagnostic persistence.
    for (const id of ids) store?.recordFileListener(id, {
      status: "stopped", observedAt: new Date().toISOString()
    });
  }
}
