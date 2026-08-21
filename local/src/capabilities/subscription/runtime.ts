import { PollPluginRunner, PollProbeExecutor } from "./plugin-runner.js";
import { SubscriptionStore } from "./store.js";
import type { ExternalRefTriggerGuard } from
  "../../modules/external-resource/trigger-binding.js";

export interface SubscriptionCycleResult {
  readonly polled: string[];
  readonly failed: ReadonlyArray<{
    readonly subscriptionId: string;
    readonly phase: "poll";
    readonly error: string;
  }>;
}

export interface SubscriptionRuntimeOptions {
  readonly databasePath: string;
  readonly pluginRunner?: PollPluginRunner;
  readonly probeExecutor?: PollProbeExecutor;
  readonly pollLimit?: number;
  readonly externalRefGuard?: ExternalRefTriggerGuard;
}

export class SubscriptionRuntime {
  readonly #databasePath: string;
  readonly #pluginRunner: PollPluginRunner;
  readonly #probeExecutor: PollProbeExecutor;
  readonly #pollLimit: number;
  readonly #externalRefGuard: ExternalRefTriggerGuard | undefined;

  public constructor(options: SubscriptionRuntimeOptions) {
    this.#databasePath = options.databasePath;
    this.#pluginRunner = options.pluginRunner ?? new PollPluginRunner();
    this.#probeExecutor = options.probeExecutor ?? new PollProbeExecutor();
    this.#pollLimit = options.pollLimit ?? 20;
    this.#externalRefGuard = options.externalRefGuard;
  }

  public reconcileInterrupted(): number {
    const store = new SubscriptionStore(this.#databasePath);
    try {
      return store.reconcileCallbacks();
    } finally {
      store.close();
    }
  }

  public async runCycle(
    signal: AbortSignal,
    now = new Date().toISOString()
  ): Promise<SubscriptionCycleResult> {
    const result: {
      polled: string[];
      failed: Array<{ subscriptionId: string; phase: "poll"; error: string }>;
    } = { polled: [], failed: [] };
    const store = new SubscriptionStore(this.#databasePath);
    try {
      store.reconcileCallbacks(now);
      for (const candidate of store.due(now, this.#pollLimit)) {
        if (signal.aborted) break;
        const subscription = store.beginAttempt(candidate.subscriptionId, now);
        result.polled.push(subscription.subscriptionId);
        try {
          if (subscription.externalRefBinding !== undefined) {
            if (this.#externalRefGuard === undefined) {
              store.blockExternalRefTrigger(subscription.subscriptionId, "guard-unavailable", now);
              result.failed.push({
                subscriptionId: subscription.subscriptionId,
                phase: "poll",
                error: "external-ref-trigger:guard-unavailable"
              });
              continue;
            }
            const checked = await this.#externalRefGuard(subscription.externalRefBinding);
            if (checked.status === "rejected") {
              store.blockExternalRefTrigger(subscription.subscriptionId, checked.reason, now);
              result.failed.push({
                subscriptionId: subscription.subscriptionId,
                phase: "poll",
                error: `external-ref-trigger:${checked.reason}`
              });
              continue;
            }
          }
          const context = {
            subscriptionId: subscription.subscriptionId,
            attempt: subscription.attemptCount,
            startedAt: subscription.startedAt,
            deadlineAt: subscription.deadlineAt
          };
          const probe = await this.#pluginRunner.plan(
            subscription.probe.plugin.path,
            subscription.probe.plugin.id,
            subscription.probe.plugin.config,
            context
          );
          const probeResult = await this.#probeExecutor.execute(
            probe,
            subscription.probe.policy,
            signal
          );
          const observation = await this.#pluginRunner.evaluate(
            subscription.probe.plugin.path,
            subscription.probe.plugin.id,
            subscription.probe.plugin.config,
            context,
            probeResult
          );
          store.recordObservation(subscription.subscriptionId, observation, now);
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
