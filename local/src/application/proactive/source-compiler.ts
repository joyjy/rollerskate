import type { FileContinuousSubscriptionDefinition } from "../../capabilities/subscription/continuous-model.js";
import { assertFileRoot } from "../../capabilities/subscription/file-source.js";
import type { DatabaseSync } from "node:sqlite";

import type {
  CreateTargetedScheduleInput,
  Schedule
} from "../../capabilities/scheduled-task/model.js";
import type { ScheduledTaskStore } from
  "../../capabilities/scheduled-task/store.js";
import type {
  FreeSubscription,
  TargetedSubscriptionDefinition
} from "../../capabilities/subscription/model.js";
import type {
  ContinuousSubscription,
  TargetedContinuousSubscriptionDefinition
} from "../../capabilities/subscription/continuous-model.js";
import type { SubscriptionStore } from
  "../../capabilities/subscription/store.js";
import type { ContinuousSubscriptionStore } from
  "../../capabilities/subscription/continuous-store.js";
import { withImmediateTransaction } from
  "../../infrastructure/sqlite/transaction.js";
import type { DeterministicApplicationActionRegistry } from "./action-registry.js";

export interface OwnerApplicationActionIntent {
  readonly actionRef: string;
  readonly input: unknown;
}

export type OwnerProactiveSourceIntent =
  | { readonly kind: "file_subscription";
      readonly source: Omit<FileContinuousSubscriptionDefinition, "target"> & { readonly subscriptionId: string };
      readonly action: OwnerApplicationActionIntent }
  | {
      readonly kind: "schedule";
      readonly source: Omit<CreateTargetedScheduleInput, "target">;
      readonly action: OwnerApplicationActionIntent;
    }
  | {
      readonly kind: "subscription";
      readonly source: Omit<TargetedSubscriptionDefinition, "target"> & {
        readonly subscriptionId: string;
      };
      readonly action: OwnerApplicationActionIntent;
    }
  | {
      readonly kind: "continuous_subscription";
      readonly source: Omit<TargetedContinuousSubscriptionDefinition, "target"> & {
        readonly subscriptionId: string;
      };
      readonly action: OwnerApplicationActionIntent;
    };

export type CompiledOwnerProactiveSource =
  | { readonly kind: "file_subscription"; readonly source: ContinuousSubscription }
  | { readonly kind: "schedule"; readonly source: Schedule }
  | { readonly kind: "subscription"; readonly source: FreeSubscription }
  | { readonly kind: "continuous_subscription"; readonly source: ContinuousSubscription };

/**
 * Owner-only compiler for deterministic proactive sources. It intentionally accepts
 * neither callbacks nor executable/argv fields; target authority comes solely from
 * the registered action ref and its frozen registration digest.
 */
export class OwnerProactiveSourceCompiler {
  readonly #database: DatabaseSync;
  readonly #actions: DeterministicApplicationActionRegistry;
  readonly #schedules: ScheduledTaskStore;
  readonly #oneShot: SubscriptionStore;
  readonly #continuous: ContinuousSubscriptionStore;

  public constructor(input: {
    readonly database: DatabaseSync;
    readonly actions: DeterministicApplicationActionRegistry;
    readonly schedules: ScheduledTaskStore;
    readonly oneShot: SubscriptionStore;
    readonly continuous: ContinuousSubscriptionStore;
  }) {
    this.#database = input.database;
    this.#actions = input.actions;
    this.#schedules = input.schedules;
    this.#oneShot = input.oneShot;
    this.#continuous = input.continuous;
  }

  public compile(
    intent: OwnerProactiveSourceIntent,
    at = new Date().toISOString()
  ): CompiledOwnerProactiveSource {
    return withImmediateTransaction(this.#database, () => this.compileInTransaction(intent, at));
  }

  public compileInTransaction(
    intent: OwnerProactiveSourceIntent,
    at: string
  ): CompiledOwnerProactiveSource {
    if (!this.#database.isTransaction) {
      throw new Error("Owner proactive source compilation requires an owning transaction");
    }
    const target = this.#actions.compileTarget(intent.action.actionRef, intent.action.input);
    if (intent.kind === "file_subscription") {
      assertFileRoot(intent.source.source);
      return { kind: intent.kind, source: this.#continuous.createFileInTransaction({ ...intent.source, target }, at) };
    }
    if (intent.kind === "schedule") {
      return {
        kind: intent.kind,
        source: this.#schedules.createTargetedInTransaction({
          ...intent.source,
          target
        }, at)
      };
    }
    if (intent.kind === "subscription") {
      return {
        kind: intent.kind,
        source: this.#oneShot.createTargetedInTransaction({
          ...intent.source,
          target
        }, at)
      };
    }
    if (intent.kind === "continuous_subscription") {
      return {
        kind: intent.kind,
        source: this.#continuous.createTargetedInTransaction({
          ...intent.source,
          target
        }, at)
      };
    }
    throw new Error("Owner proactive source intent kind is unsupported");
  }
}
