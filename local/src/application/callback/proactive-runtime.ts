import { HostCallbackKernel } from "../../infrastructure/callback/host-kernel.js";
import type { ProactiveCallbackOccurrence } from "../../modules/callback/proactive-model.js";
import type { CreateEvent } from "../../core/event/model.js";
import {
  CallbackStore,
  type ProactiveAgentCompletion,
  type ProactiveCallbackOccurrenceRef
} from "../../infrastructure/callback/store.js";

export interface ProactiveCallbackTickResult {
  readonly admitted: string[];
  readonly succeeded: string[];
  readonly failed: string[];
  readonly reconciled: number;
}

export interface ProactiveCallbackOwnerAdapter {
  createAgentEvent(callback: ProactiveCallbackOccurrence, at: string): CreateEvent;
  commandContext?(callback: ProactiveCallbackOccurrence): unknown;
  interpretAgentCompletion?(
    callback: ProactiveCallbackOccurrence,
    output: string | undefined
  ): ProactiveAgentCompletion;
}

export interface ProactiveCallbackRuntimeOptions {
  readonly ownerAdapters: ReadonlyMap<
    ProactiveCallbackOccurrence["owner"]["kind"],
    ProactiveCallbackOwnerAdapter
  >;
  readonly kernel?: HostCallbackKernel;
}

export class ProactiveCallbackRuntime {
  readonly #databasePath: string;
  readonly #ownerAdapters: ProactiveCallbackRuntimeOptions["ownerAdapters"];
  readonly #kernel: HostCallbackKernel;

  public constructor(databasePath: string, options: ProactiveCallbackRuntimeOptions) {
    this.#databasePath = databasePath;
    this.#ownerAdapters = options.ownerAdapters;
    this.#kernel = options.kernel ?? new HostCallbackKernel();
  }

  public recover(at = new Date().toISOString()): number {
    const store = new CallbackStore(this.#databasePath);
    try {
      let total = 0;
      for (;;) {
        const changed = store.reconcileInterrupted(at, 100);
        total += changed;
        if (changed < 100) return total;
      }
    } finally {
      store.close();
    }
  }

  public async tick(
    signal: AbortSignal,
    at = new Date().toISOString()
  ): Promise<ProactiveCallbackTickResult> {
    const store = new CallbackStore(this.#databasePath);
    const result = {
      admitted: [],
      succeeded: [],
      failed: [],
      reconciled: 0
    };
    try {
      result.reconciled = store.reconcileCompleted(at, {
        limit: 100,
        interpretAgentCompletion: (callback, output) => {
          const interpreter = this.#ownerAdapters.get(
            callback.owner.kind
          )?.interpretAgentCompletion;
          if (interpreter === undefined && callback.owner.kind === "subscription") {
            return {
              status: "failed",
              error: "subscription completion interpreter unavailable",
              receipt: { outcome: "failed", error: "completion_interpreter_unavailable" }
            };
          }
          return interpreter?.(
            callback,
            output
          ) ?? { status: "succeeded" };
        }
      });
      for (const ref of store.ready()) await this.#runOccurrence(store, ref, signal, at, result);
      return result;
    } finally {
      store.close();
    }
  }

  async #runOccurrence(
    store: CallbackStore,
    ref: ProactiveCallbackOccurrenceRef,
    signal: AbortSignal,
    at: string,
    result: ProactiveCallbackTickResult
  ): Promise<void> {
    for (let ordinal = 0; ordinal < 64 && !signal.aborted; ordinal += 1) {
      const callback = store.beginNext(ref, at);
      if (callback === undefined) return;
      try {
        if (callback.kind === "agent.invoke") {
          const adapter = this.#ownerAdapters.get(callback.owner.kind);
          if (adapter === undefined) {
            throw new Error(`callback owner adapter unavailable: ${callback.owner.kind}`);
          }
          store.admitAgentEvent(
            callback.occurrenceId,
            adapter.createAgentEvent(callback, at),
            at
          );
          result.admitted.push(callback.occurrenceId);
          return;
        }
        if (callback.kind === "destination.deliver") {
          this.#destination(store, callback, at);
          result.admitted.push(callback.occurrenceId);
          return;
        }
        const adapter = this.#ownerAdapters.get(callback.owner.kind);
        const receipt = await this.#kernel.executeCommand(
          callback.definition,
          callback.grant,
          signal,
          callbackInput(callback, adapter?.commandContext?.(callback))
        );
        store.succeed(callback.occurrenceId, receipt, at);
        result.succeeded.push(callback.occurrenceId);
      } catch (error) {
        store.fail(callback.occurrenceId, message(error), {
          schemaVersion: "ProactiveCallbackReceipt@1",
          outcome: "failed"
        }, at);
        result.failed.push(callback.occurrenceId);
      }
    }
  }

  #destination(
    store: CallbackStore,
    callback: ProactiveCallbackOccurrence,
    at: string
  ): void {
    const definition = callback.definition;
    const kind = text(definition.destinationKind, "callback destinationKind");
    if (kind !== "matrix" && kind !== "macos-notification") {
      throw new Error(`Unsupported proactive destination: ${kind}`);
    }
    store.admitDelivery(callback.occurrenceId, {
      destinationId: text(definition.destinationId, "callback destinationId"),
      kind,
      address: stringRecord(definition.address, "callback destination address"),
      payload: object(definition.payload, "callback destination payload")
    }, at);
  }
}

function callbackInput(
  callback: ProactiveCallbackOccurrence,
  context: unknown
): string {
  const input = JSON.stringify({
    schemaVersion: "ProactiveCallbackInput@1",
    occurrence: {
      occurrenceId: callback.occurrenceId,
      owner: callback.owner,
      triggerOccurrenceKey: callback.triggerOccurrenceKey
    },
    ...(context === undefined ? {} : { context })
  });
  if (Buffer.byteLength(input, "utf8") > 1_048_576) {
    throw new Error("callback input exceeds 1048576 bytes");
  }
  return input;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  const result = object(value, field);
  if (Object.values(result).some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a string record`);
  }
  return result as Readonly<Record<string, string>>;
}

function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
