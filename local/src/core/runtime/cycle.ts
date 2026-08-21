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
  readonly #activeExecutions = new Map<string, Promise<void>>();
  readonly #activeDeliveries = new Map<string, Promise<void>>();
  readonly #completedExecutions: string[] = [];
  readonly #completedDeliveries: string[] = [];
  readonly #completedFailures: RuntimeCycleFailure[] = [];

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

  public async run(at?: string): Promise<RuntimeCycleResult> {
    const executions: string[] = [];
    const deliveries: string[] = [];
    const failures: RuntimeCycleFailure[] = [];

    let remainingExecutions = 100;
    while (remainingExecutions > 0) {
      const claimed = this.#store.claimDueExecutions(
        Math.min(20, remainingExecutions),
        at ?? new Date().toISOString()
      );
      if (claimed.length === 0) break;
      remainingExecutions -= claimed.length;
      const outcomes = await Promise.all(claimed.map((execution) =>
        this.#handleExecution(execution.executionId, at)));
      for (const outcome of outcomes) {
        if (outcome.failure === undefined) executions.push(outcome.executionId!);
        else failures.push(outcome.failure);
      }
    }
    for (const delivery of this.#store.claimDueDeliveries(
      100,
      at ?? new Date().toISOString()
    )) {
      const outcome = await this.#handleDelivery(delivery.deliveryId, at);
      if (outcome.failure === undefined) deliveries.push(outcome.deliveryId!);
      else failures.push(outcome.failure);
    }
    return { executions, deliveries, failures };
  }

  public poll(at?: string): RuntimeCycleResult {
    const completed = this.#takeCompleted();
    const executionCapacity = Math.max(0, 100 - this.#activeExecutions.size);
    const executions = executionCapacity === 0
      ? []
      : this.#store.claimDueExecutions(
          Math.min(20, executionCapacity),
          at ?? new Date().toISOString()
        );
    for (const execution of executions) {
      const task = this.#handleExecution(execution.executionId, at).then((outcome) => {
        this.#activeExecutions.delete(execution.executionId);
        if (outcome.failure === undefined) {
          this.#completedExecutions.push(outcome.executionId!);
        } else {
          this.#completedFailures.push(outcome.failure);
        }
      });
      this.#activeExecutions.set(execution.executionId, task);
    }
    const deliveryCapacity = Math.max(0, 100 - this.#activeDeliveries.size);
    const deliveries = deliveryCapacity === 0
      ? []
      : this.#store.claimDueDeliveries(
          deliveryCapacity,
          at ?? new Date().toISOString()
        );
    for (const delivery of deliveries) {
      const task = this.#handleDelivery(delivery.deliveryId, at).then((outcome) => {
        this.#activeDeliveries.delete(delivery.deliveryId);
        if (outcome.failure === undefined) {
          this.#completedDeliveries.push(outcome.deliveryId!);
        } else {
          this.#completedFailures.push(outcome.failure);
        }
      });
      this.#activeDeliveries.set(delivery.deliveryId, task);
    }
    return completed;
  }

  public async settle(): Promise<RuntimeCycleResult> {
    while (this.#activeExecutions.size > 0 || this.#activeDeliveries.size > 0) {
      await Promise.all([
        ...this.#activeExecutions.values(),
        ...this.#activeDeliveries.values()
      ]);
    }
    return this.#takeCompleted();
  }

  async #handleExecution(
    executionId: string,
    at?: string
  ): Promise<{ executionId?: string; failure?: RuntimeCycleFailure }> {
    const execution = this.#store.execution(executionId);
    if (execution === undefined) {
      return {
        failure: { phase: "execution", id: executionId, error: `Execution not found: ${executionId}` }
      };
    }
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
      return { executionId };
    } catch (error) {
      const failure = message(error);
      try {
        this.#store.failExecution(
          executionId,
          failure,
          at ?? new Date().toISOString()
        );
      } catch {
        // The handler may already have moved the Execution to a durable terminal state.
      }
      return { failure: { phase: "execution", id: executionId, error: failure } };
    }
  }

  async #handleDelivery(
    deliveryId: string,
    at?: string
  ): Promise<{ deliveryId?: string; failure?: RuntimeCycleFailure }> {
    const delivery = this.#store.delivery(deliveryId);
    if (delivery === undefined) {
      return {
        failure: { phase: "delivery", id: deliveryId, error: `Delivery not found: ${deliveryId}` }
      };
    }
    try {
      await this.#deliveryHandler.handle(delivery, at);
      return { deliveryId };
    } catch (error) {
      const failure = message(error);
      try {
        this.#store.deliveryFailed(
          deliveryId,
          failure,
          at ?? new Date().toISOString()
        );
      } catch {
        // The handler may already have moved the Delivery to a durable terminal state.
      }
      return { failure: { phase: "delivery", id: deliveryId, error: failure } };
    }
  }

  #takeCompleted(): RuntimeCycleResult {
    return {
      executions: this.#completedExecutions.splice(0),
      deliveries: this.#completedDeliveries.splice(0),
      failures: this.#completedFailures.splice(0)
    };
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
