import { localId } from "../../core/id.js";
import type { RuntimeStore } from "../../core/runtime/store.js";
import type { BoundContinuousSubscriptionDefinition } from
  "../../capabilities/subscription/continuous-model.js";
import type { ContinuousSubscriptionStore } from
  "../../capabilities/subscription/continuous-store.js";
import type { BoundSubscriptionDefinition } from
  "../../capabilities/subscription/model.js";
import type { SubscriptionRunBindingAdapter } from
  "../../capabilities/subscription/run-binding.js";
import type { SubscriptionStore } from "../../capabilities/subscription/store.js";
import type { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { activateRunSourceOccurrenceInTransaction } from
  "../steward/source-control.js";
import type { StewardSourceBindingRegistrar } from "../steward/decision.js";
import {
  runAuthorityDigest,
  type RunAuthorityEnvelope
} from "../../modules/steward/admission-contract.js";
import { parseExternalRefTriggerBinding } from
  "../../modules/external-resource/trigger-binding.js";
import type { RunSourceBinding } from "../../modules/steward/source-contract.js";
import type { RegisteredSubscriptionPlugin } from "./plugin-registry.js";
import { resolveSpecToken } from "../../modules/spec/registry.js";

export type { RegisteredSubscriptionPlugin } from "./plugin-registry.js";

export const SUBSCRIPTION_UNTIL_TEMPLATE_ID = "subscription.until@1";
export const SUBSCRIPTION_CONTINUOUS_TEMPLATE_ID = "subscription.continuous@1";

export function subscriptionRunBindingAdapter(input: {
  readonly runtime: RuntimeStore;
  readonly runs: AgentRunStore;
}): SubscriptionRunBindingAdapter {
  return {
    activateOccurrenceInTransaction({ agentRunId, envelope, at }) {
      const receipt = activateRunSourceOccurrenceInTransaction({
        runtime: input.runtime,
        runs: input.runs,
        runId: agentRunId,
        envelope,
        at
      });
      return {
        cycleId: receipt.cycle.cycleId,
        orchestratorEventId: receipt.orchestratorEventId,
        orchestratorExecutionId: receipt.orchestratorExecutionId
      };
    },
    runState(runId) {
      const run = input.runs.projection(runId);
      return run === undefined
        ? undefined
        : {
            status: run.status,
            ...(run.activeCycleId === undefined ? {} : { activeCycleId: run.activeCycleId })
          };
    },
    cycleState(cycleId) {
      const cycle = input.runs.cycle(cycleId);
      return cycle === undefined
        ? undefined
        : {
            status: cycle.status,
            ...(cycle.terminalSummary === undefined
              ? {}
              : { terminalSummary: cycle.terminalSummary }),
            ...(cycle.completedAt === undefined ? {} : { completedAt: cycle.completedAt })
          };
    }
  };
}

export function subscriptionSourceBindingRegistrar(input: {
  readonly oneShot: SubscriptionStore;
  readonly continuous: ContinuousSubscriptionStore;
  readonly resolvePlugin: (ref: string) => RegisteredSubscriptionPlugin | undefined;
}): StewardSourceBindingRegistrar {
  return ({ run, decision, at }) => {
    if (run.orchestratorBinding?.schemaVersion !== "OrchestratorBinding@3") {
      throw new Error("Subscription source registration requires an admitted Steward Run");
    }
    const continuous = decision.awaitSource.sourceKind === "continuous_subscription";
    const template = resolveSpecToken(decision.awaitSource.templateId, {
      kind: "template"
    });
    const capability = resolveSpecToken("subscription@1", { kind: "capability" });
    if (template.capabilityRef !== capability.ref) {
      throw new Error("Subscription template is not owned by the Subscription capability");
    }
    if ((!continuous && decision.awaitSource.sourceKind !== "subscription") ||
      template.ref !== (continuous
        ? "spec:rollerskate/subscription.continuous@1"
        : "spec:rollerskate/subscription.until@1")) {
      throw new Error("Subscription source kind and template do not match");
    }
    const parameters = parseTemplate(decision.awaitSource.parameters, continuous);
    const authority = run.orchestratorBinding.authority.trigger;
    const kind = continuous ? "continuous" : "until";
    if (authority === undefined || !authority.allowedKinds.includes(kind)) {
      throw new Error(`Subscription kind is not admitted by Run authority: ${kind}`);
    }
    if (!authority.pluginRefs.includes(parameters.pluginRef)) {
      throw new Error("Subscription pluginRef is not admitted by Run authority");
    }
    const plugin = input.resolvePlugin(parameters.pluginRef);
    if (plugin === undefined || plugin.ref !== parameters.pluginRef) {
      throw new Error(`Subscription plugin is not registered: ${parameters.pluginRef}`);
    }
    if (!plugin.triggerKinds.includes(kind)) {
      throw new Error(`Subscription plugin is not registered for ${kind}`);
    }
    if (authority.pluginPolicyDigests?.[plugin.ref] !== plugin.authorityDigest) {
      throw new Error("Subscription plugin registry changed after Run admission");
    }
    assertPluginPolicy(plugin, authority);
    assertInterval(parameters.intervalMilliseconds, authority);
    const subscriptionId = continuous
      ? input.continuous.boundForRun(run.runId)?.subscriptionId ?? localId("sub")
      : input.oneShot.boundForRun(run.runId)?.subscriptionId ?? localId("sub");
    const definitionRevision = continuous
      ? "ContinuousSubscriptionDefinition@2:1"
      : "SubscriptionDefinition@4:1";
    const binding: RunSourceBinding = {
      schemaVersion: "RunSourceBinding@1",
      runId: run.runId,
      seriesKey: `source:${continuous ? "continuous-subscription" : "subscription"}:${run.runId}`,
      source: {
        kind: continuous ? "continuous_subscription" : "subscription",
        id: subscriptionId,
        definitionRevision
      },
      authorityDigest: runAuthorityDigest(run.orchestratorBinding.authority),
      occurrencePolicy: continuous ? "recurring" : "one_shot",
      cancellationPolicy: parameters.cancellationPolicy,
      reconcilePolicy: "source_owned"
    };
    const probe = {
      plugin: {
        path: plugin.path,
        id: plugin.id,
        schemaVersion: 1 as const,
        config: parameters.pluginConfig
      },
      policy: {
        workspaceRoot: plugin.workspaceRoot,
        allowedHttpOrigins: plugin.allowedHttpOrigins,
        allowedExecutables: plugin.allowedExecutables,
        allowedEnvironment: [] as string[],
        timeoutMilliseconds: 30_000,
        maxOutputBytes: 65_536
      }
    };
    if (continuous) {
      const definition: BoundContinuousSubscriptionDefinition = {
        schemaVersion: "ContinuousSubscriptionDefinition@2",
        revision: 1,
        title: parameters.title,
        probe,
        intervalMilliseconds: parameters.intervalMilliseconds,
        sourceBinding: binding,
        ...(parameters.externalRefBinding === undefined
          ? {}
          : { externalRefBinding: parameters.externalRefBinding })
      };
      resolveSpecToken(definition.schemaVersion, { kind: "contract" });
      input.continuous.createBoundInTransaction({
        ...definition,
        subscriptionId
      }, at);
      return binding;
    }
    const definition: BoundSubscriptionDefinition = {
      schemaVersion: "SubscriptionDefinition@4",
      revision: "1",
      title: parameters.title,
      probe: {
        ...probe,
        artifactRevision: plugin.artifactRevision,
        artifactDigest: plugin.artifactDigest
      },
      intervalMilliseconds: parameters.intervalMilliseconds,
      maxWaitMilliseconds: parameters.maxWaitMilliseconds!,
      maxAttempts: parameters.maxAttempts!,
      sourceBinding: binding,
      ...(parameters.externalRefBinding === undefined
        ? {}
        : { externalRefBinding: parameters.externalRefBinding })
    };
    resolveSpecToken(definition.schemaVersion, { kind: "contract" });
    input.oneShot.createBoundInTransaction({
      ...definition,
      subscriptionId
    }, at);
    return binding;
  };
}

function assertPluginPolicy(
  plugin: RegisteredSubscriptionPlugin,
  authority: NonNullable<RunAuthorityEnvelope["trigger"]>
): void {
  if (plugin.allowedHttpOrigins.some((origin) => !authority.allowedHttpOrigins.includes(origin)) ||
    plugin.allowedExecutables.some((path) => !authority.allowedExecutables.includes(path))) {
    throw new Error("Subscription plugin policy exceeds admitted Run authority");
  }
}

interface SubscriptionTemplate {
  readonly title: string;
  readonly pluginRef: string;
  readonly pluginConfig: unknown;
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds?: number;
  readonly maxAttempts?: number;
  readonly cancellationPolicy: RunSourceBinding["cancellationPolicy"];
  readonly externalRefBinding?: ReturnType<typeof parseExternalRefTriggerBinding>;
}

function parseTemplate(
  value: Readonly<Record<string, unknown>>,
  continuous: boolean
): SubscriptionTemplate {
  const allowed = [
    "title", "pluginRef", "pluginConfig", "intervalMilliseconds",
    ...(continuous ? [] : ["maxWaitMilliseconds", "maxAttempts"]),
    "cancellationPolicy", "externalRefBinding"
  ];
  const optional = ["externalRefBinding"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !optional.includes(key) && value[key] === undefined);
  if (unknown.length > 0) throw new Error(`Subscription template has unknown field: ${unknown[0]}`);
  if (missing.length > 0) throw new Error(`Subscription template is missing field: ${missing[0]}`);
  if (value.cancellationPolicy !== "pause_source" &&
    value.cancellationPolicy !== "cancel_source") {
    throw new Error("Subscription template cancellationPolicy is unsupported");
  }
  return {
    title: text(value.title, "title", 120),
    pluginRef: text(value.pluginRef, "pluginRef", 512),
    pluginConfig: value.pluginConfig,
    intervalMilliseconds: integer(value.intervalMilliseconds, "intervalMilliseconds", 100),
    ...(continuous ? {} : {
      maxWaitMilliseconds: integer(value.maxWaitMilliseconds, "maxWaitMilliseconds", 100),
      maxAttempts: integer(value.maxAttempts, "maxAttempts", 1, 100_000)
    }),
    cancellationPolicy: value.cancellationPolicy,
    ...(value.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: parseExternalRefTriggerBinding(value.externalRefBinding) })
  };
}

function assertInterval(
  interval: number,
  authority: NonNullable<RunAuthorityEnvelope["trigger"]>
): void {
  if (authority.minimumIntervalMilliseconds !== undefined &&
    interval < authority.minimumIntervalMilliseconds) {
    throw new Error("Subscription interval is below admitted trigger authority");
  }
  if (authority.maximumIntervalMilliseconds !== undefined &&
    interval > authority.maximumIntervalMilliseconds) {
    throw new Error("Subscription interval exceeds admitted trigger authority");
  }
}

function integer(value: unknown, field: string, minimum: number, maximum = 86_400_000): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}
