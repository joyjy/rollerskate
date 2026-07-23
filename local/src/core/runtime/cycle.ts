import {
  DeliveryHandler,
  type RuntimeEventHandler
} from "./handlers.js";
import { runtimeRoute } from "./model.js";
import { RuntimeStore } from "./store.js";

export interface RuntimeCycleFailure {
  readonly phase: "execution" | "delivery";
  readonly id: string;
  readonly error: string;
}

export interface RuntimeCycleResult {
  readonly executions: readonly string[];
  readonly deliveries: readonly string[];
  readonly failures: readonly RuntimeCycleFailure[];
}

export class RuntimeCycle {
  readonly #deliveryHandler: Pick<DeliveryHandler, "handle">;
  readonly #handlers: ReadonlyMap<RuntimeEventHandler["kind"], RuntimeEventHandler>;
  readonly #store: RuntimeStore;

  public constructor(options: {
    readonly store: RuntimeStore;
    readonly handlers: ReadonlyMap<RuntimeEventHandler["kind"], RuntimeEventHandler>;
    readonly deliveryHandler: Pick<DeliveryHandler, "handle">;
  }) {
    this.#store = options.store;
    this.#handlers = options.handlers;
    for (const [kind, handler] of this.#handlers) {
      if (handler.kind !== kind) throw new Error(`Handler registry key mismatch: ${kind}`);
    }
    this.#deliveryHandler = options.deliveryHandler;
  }

  public async run(at = new Date().toISOString()): Promise<RuntimeCycleResult> {
    const executions: string[] = [];
    const deliveries: string[] = [];
    const failures: RuntimeCycleFailure[] = [];

    let remainingExecutions = 100;
    while (remainingExecutions > 0) {
      const claimed = this.#store.claimDueExecutions(Math.min(20, remainingExecutions), at);
      if (claimed.length === 0) break;
      remainingExecutions -= claimed.length;
      for (const execution of claimed) {
        try {
          const event = this.#store.event(execution.eventId);
          if (event === undefined) throw new Error(`Event not found: ${execution.eventId}`);
          const route = runtimeRoute(event.type);
          if (execution.handler !== route.handler) {
            throw new Error(`Execution does not match Event Route: ${execution.executionId}`);
          }
          const handler = this.#handlers.get(route.handler);
          if (handler === undefined) throw new Error(`Handler not available: ${route.handler}`);
          await handler.handle(execution, at);
          executions.push(execution.executionId);
        } catch (error) {
          const failure = message(error);
          try {
            this.#store.failExecution(execution.executionId, failure, at);
          } catch {
            // The handler may already have moved the Execution to a durable terminal state.
          }
          failures.push({ phase: "execution", id: execution.executionId, error: failure });
        }
      }
    }
    for (const delivery of this.#store.claimDueDeliveries(100, at)) {
      try {
        await this.#deliveryHandler.handle(delivery, at);
        deliveries.push(delivery.deliveryId);
      } catch (error) {
        const failure = message(error);
        try {
          this.#store.deliveryFailed(delivery.deliveryId, failure, at);
        } catch {
          // The handler may already have moved the Delivery to a durable terminal state.
        }
        failures.push({ phase: "delivery", id: delivery.deliveryId, error: failure });
      }
    }
    return { executions, deliveries, failures };
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
