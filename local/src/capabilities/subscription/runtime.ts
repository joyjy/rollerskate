import { PollPluginRunner, PollProbeExecutor } from "./plugin-runner.js";
import { PollSubscriptionStore } from "./store.js";

export interface PollSubscriptionCycleResult {
  readonly polled: string[];
  readonly fired: ReadonlyArray<{ readonly subscriptionId: string; readonly eventId: string }>;
  readonly failed: ReadonlyArray<{
    readonly subscriptionId: string;
    readonly phase: "poll";
    readonly error: string;
  }>;
}

export interface PollSubscriptionRuntimeOptions {
  readonly databasePath: string;
  readonly pluginRunner?: PollPluginRunner;
  readonly probeExecutor?: PollProbeExecutor;
  readonly pollLimit?: number;
}

export class PollSubscriptionRuntime {
  readonly #databasePath: string;
  readonly #pluginRunner: PollPluginRunner;
  readonly #probeExecutor: PollProbeExecutor;
  readonly #pollLimit: number;

  public constructor(options: PollSubscriptionRuntimeOptions) {
    this.#databasePath = options.databasePath;
    this.#pluginRunner = options.pluginRunner ?? new PollPluginRunner();
    this.#probeExecutor = options.probeExecutor ?? new PollProbeExecutor();
    this.#pollLimit = options.pollLimit ?? 20;
  }

  public reconcileInterrupted(): number {
    return 0;
  }

  public async runCycle(
    signal: AbortSignal,
    now = new Date().toISOString()
  ): Promise<PollSubscriptionCycleResult> {
    const result: {
      polled: string[];
      fired: Array<{ subscriptionId: string; eventId: string }>;
      failed: Array<{ subscriptionId: string; phase: "poll"; error: string }>;
    } = { polled: [], fired: [], failed: [] };
    const store = new PollSubscriptionStore(this.#databasePath);
    try {
      for (const candidate of store.due(now, this.#pollLimit)) {
        if (signal.aborted) break;
        const subscription = store.beginAttempt(candidate.subscriptionId, now);
        result.polled.push(subscription.subscriptionId);
        try {
          const context = {
            subscriptionId: subscription.subscriptionId,
            attempt: subscription.attemptCount,
            startedAt: subscription.startedAt,
            deadlineAt: subscription.deadlineAt
          };
          const probe = await this.#pluginRunner.plan(
            subscription.pluginPath,
            subscription.pluginId,
            subscription.pluginConfig,
            context
          );
          const probeResult = await this.#probeExecutor.execute(probe, subscription.policy, signal);
          const observation = await this.#pluginRunner.evaluate(
            subscription.pluginPath,
            subscription.pluginId,
            subscription.pluginConfig,
            context,
            probeResult
          );
          const recorded = store.recordObservation(subscription.subscriptionId, observation, now);
          if (recorded.fireEventId !== undefined) {
            result.fired.push({
              subscriptionId: subscription.subscriptionId,
              eventId: recorded.fireEventId
            });
          }
        } catch (error) {
          const failure = message(error);
          store.recordPollFailure(subscription.subscriptionId, failure, now);
          result.failed.push({
            subscriptionId: subscription.subscriptionId,
            phase: "poll",
            error: failure
          });
        }
      }
      return result;
    } finally {
      store.close();
    }
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
