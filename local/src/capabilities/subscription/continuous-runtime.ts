import { PollPluginRunner, PollProbeExecutor } from "./plugin-runner.js";
import { ContinuousSubscriptionStore } from "./continuous-store.js";
import type { ExternalRefTriggerGuard } from
  "../../modules/external-resource/trigger-binding.js";

export interface ContinuousSubscriptionCycleResult {
  readonly polled: string[];
  readonly deltas: string[];
  readonly checkpointed: string[];
  readonly failed: string[];
}

export class ContinuousSubscriptionRuntime {
  readonly #databasePath: string;
  readonly #pluginRunner: PollPluginRunner;
  readonly #probeExecutor: PollProbeExecutor;
  readonly #externalRefGuard: ExternalRefTriggerGuard | undefined;
  readonly #store: ContinuousSubscriptionStore | undefined;

  public constructor(options: {
    readonly databasePath: string;
    readonly store?: ContinuousSubscriptionStore;
    readonly pluginRunner?: PollPluginRunner;
    readonly probeExecutor?: PollProbeExecutor;
    readonly externalRefGuard?: ExternalRefTriggerGuard;
  }) {
    this.#databasePath = options.databasePath;
    this.#pluginRunner = options.pluginRunner ?? new PollPluginRunner();
    this.#probeExecutor = options.probeExecutor ?? new PollProbeExecutor();
    this.#externalRefGuard = options.externalRefGuard;
    this.#store = options.store;
  }

  public async runCycle(
    signal: AbortSignal,
    at = new Date().toISOString()
  ): Promise<ContinuousSubscriptionCycleResult> {
    const store = this.#store ?? new ContinuousSubscriptionStore(this.#databasePath);
    try {
      const result = {
        polled: [] as string[],
        deltas: [] as string[],
        checkpointed: [
          ...store.finalizeCallbacks(at),
          ...store.reconcileBoundOccurrences(at)
        ],
        failed: [] as string[]
      };
      for (const candidate of store.due(at)) {
        if (signal.aborted) break;
        const subscription = store.beginPoll(candidate.subscriptionId, at);
        result.polled.push(subscription.subscriptionId);
        try {
          const freshnessEvidence = [
            `continuous-subscription-definition:${subscription.definition.revision}`
          ];
          if (subscription.definition.externalRefBinding !== undefined) {
            if (this.#externalRefGuard === undefined) {
              store.blockExternalRefTrigger(subscription.subscriptionId, "guard-unavailable", at);
              result.failed.push(subscription.subscriptionId);
              continue;
            }
            const checked = await this.#externalRefGuard(
              subscription.definition.externalRefBinding
            );
            if (checked.status === "rejected") {
              store.blockExternalRefTrigger(subscription.subscriptionId, checked.reason, at);
              result.failed.push(subscription.subscriptionId);
              continue;
            }
            freshnessEvidence.push(
              `external-ref:${subscription.definition.externalRefBinding.ref.revision}`
            );
          }
          const context = {
            subscriptionId: subscription.subscriptionId,
            attempt: subscription.pollCount,
            startedAt: subscription.createdAt,
            ...(subscription.checkpointObservation === undefined
              ? {}
              : { previousObservation: subscription.checkpointObservation })
          };
          const plugin = subscription.definition.probe.plugin;
          const probe = await this.#pluginRunner.plan(
            plugin.path,
            plugin.id,
            plugin.config,
            context
          );
          const probeResult = await this.#probeExecutor.execute(
            probe,
            subscription.definition.probe.policy,
            signal
          );
          const observation = await this.#pluginRunner.evaluate(
            plugin.path,
            plugin.id,
            plugin.config,
            context,
            probeResult
          );
          const recorded = store.recordObservation(
            subscription.subscriptionId,
            observation,
            at,
            freshnessEvidence
          );
          if (recorded.delta) result.deltas.push(subscription.subscriptionId);
        } catch (error) {
          store.recordPollFailure(
            subscription.subscriptionId,
            error instanceof Error ? error.message : String(error),
            at
          );
          result.failed.push(subscription.subscriptionId);
        }
      }
      return result;
    } finally {
      if (this.#store === undefined) store.close();
    }
  }
}
