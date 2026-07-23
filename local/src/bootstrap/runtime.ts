import { chmodSync, mkdirSync } from "node:fs";

import type { RoomEventPage, RoomHead } from "../protocol.js";
import { LoopControlStore } from "../application/loop-control-store.js";
import { RoomPolicyStore } from "../application/room-policy-store.js";
import { AgentCredentialStore, type ActiveAgentCredential } from "../application/agent/credential-store.js";
import { LocalAgentRegistryStore } from "../application/agent/registry-store.js";
import { LocalDeviceStore } from "../application/device/store.js";
import { PollProbeExecutor } from "../capabilities/subscription/plugin-runner.js";
import { PollSubscriptionRuntime } from "../capabilities/subscription/runtime.js";
import {
  AgentHandler,
  DeliveryHandler,
  ResultHandler,
  type RuntimeAgentAdapter,
  type RuntimeEventHandler
} from "../core/runtime/handlers.js";
import type { RuntimeHandlerKind } from "../core/runtime/model.js";
import { RuntimeCycle } from "../core/runtime/cycle.js";
import { RuntimeStore } from "../core/runtime/store.js";
import { runLoop, type LoopPhase, type LoopResult } from "../core/loop.js";
import { CodexRuntimeAgent } from "../integrations/agent/codex.js";
import {
  MatrixDeliveryAdapter,
  MatrixIngress,
  type MatrixHistory
} from "../integrations/matrix/runtime-adapter.js";
import { DeviceServerClient } from "../integrations/server/device-client.js";
import {
  RoomServerClient,
  RoomServerPublisherRouter
} from "../integrations/server/room-client.js";
import { runtimePaths } from "../application/runtime-config.js";
import { initializeRuntimeSchema } from "../application/runtime-schema.js";

export interface RuntimeStartOptions {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  readonly codexExecutable?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly pollMilliseconds?: number;
  readonly codexTimeoutMilliseconds?: number;
  readonly output?: { readonly write: (text: string) => void };
  readonly fetch?: typeof fetch;
}

export async function startRuntime(
  options: RuntimeStartOptions,
  signal: AbortSignal
): Promise<LoopResult> {
  initializeRuntimeSchema(runtimePaths(options.repoRoot, options.runtimeDirectory).database);
  const resources = await assembleRuntime(options);
  try {
    const reconciledAt = new Date().toISOString();
    resources.runtimeStore.reconcileInterrupted(reconciledAt);
    resources.subscriptions.reconcileInterrupted();
    return await runLoop({
      statePath: resources.paths.loopState,
      runtimeDirectory: resources.paths.runtimeDirectory,
      agentNames: resources.agentNames,
      roomIds: resources.roomIds,
      phases: resources.phases,
      paused: () => resources.loopControl.paused(),
      ...(options.pollMilliseconds === undefined
        ? {}
        : { pollMilliseconds: options.pollMilliseconds }),
      ...(options.output === undefined ? {} : { output: options.output })
    }, signal);
  } finally {
    try {
      resources.matrixIngress?.close();
    } finally {
      try {
        resources.matrixDelivery?.close();
      } finally {
        resources.runtimeStore.close();
      }
    }
  }
}

async function assembleRuntime(options: RuntimeStartOptions) {
  const paths = runtimePaths(options.repoRoot, options.runtimeDirectory);
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.runtimeDirectory, 0o700);
  const deviceStore = new LocalDeviceStore(paths.database);
  const registry = new LocalAgentRegistryStore(paths.database);
  const runtimeStore = new RuntimeStore(paths.database);
  let handedOff = false;
  try {
    const device = deviceStore.current();
    const credentialStore = new AgentCredentialStore(paths.agentCredentials);
    const runtimeAgents = new Map<string, RuntimeAgentAdapter>();
    const publishers = new Map<string, RoomServerClient>();
    const roomClients = new Map<string, RoomServerClient>();
    const bindings = [];
    const roomPolicies = new RoomPolicyStore(paths.matrixPolicy);
    const loopControl = new LoopControlStore(paths.loopControl);
    const agentNames: string[] = [];
    for (const metadata of registry.list().filter((agent) => agent.status === "active")) {
      agentNames.push(metadata.name);
      const agent = new CodexRuntimeAgent({
        executable: requireExecutable(options.codexExecutable, "Codex"),
        projectRoot: metadata.workspacePath,
        environment: options.environment,
        timeoutMilliseconds: options.codexTimeoutMilliseconds ?? 300_000
      });
      runtimeAgents.set(metadata.agentId, agent);
      const credential = credentialStore.load(metadata.name);
      if (credential?.state !== "active" || device?.status !== "active" ||
        device.humanId === undefined) continue;
      let client: RoomServerClient;
      let summary: Awaited<ReturnType<DeviceServerClient["agentPrincipal"]>>;
      let remoteBindings: Awaited<ReturnType<RoomServerClient["bindings"]>>;
      try {
        client = roomClient(credential, options.fetch);
        summary = await new DeviceServerClient({
          serverUrl: credential.serverUrl,
          credential: credential.credential,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch })
        }).agentPrincipal(credential.agentId);
        remoteBindings = await client.bindings();
      } catch (error) {
        options.output?.write(`${JSON.stringify({
          type: "runtime.adapter_unavailable",
          adapter: "matrix",
          agentId: metadata.agentId,
          error: message(error)
        })}\n`);
        continue;
      }
      publishers.set(metadata.agentId, client);
      for (const binding of remoteBindings) {
        roomClients.set(binding.roomId, client);
        bindings.push({
          bindingId: binding.id,
          agentId: metadata.agentId,
          agentName: metadata.name,
          credentialId: credential.credentialId,
          placementId: metadata.placementId,
          roomId: binding.roomId,
          ownerHumanId: summary.owner.id,
          operatorHumanId: summary.operator.id,
          policy: roomPolicies.matrixPolicy(
            metadata.agentId,
            binding.roomId,
            binding.wakeMode
          )
        });
      }
    }
    const matrixIngress = bindings.length === 0 ? undefined : new MatrixIngress({
      databasePath: paths.database,
      history: new RoomHistoryRouter(roomClients)
    });
    for (const binding of bindings) matrixIngress?.register(binding);
    const matrixDelivery = publishers.size === 0 ? undefined : new MatrixDeliveryAdapter({
      databasePath: paths.database,
      publisher: new RoomServerPublisherRouter(publishers)
    });
    const subscriptions = new PollSubscriptionRuntime({
      databasePath: paths.database,
      probeExecutor: new PollProbeExecutor({
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      })
    });
    const runtimeCycle = new RuntimeCycle({
      store: runtimeStore,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", new AgentHandler({ store: runtimeStore, adapters: runtimeAgents })],
        ["result", new ResultHandler(runtimeStore)]
      ]),
      deliveryHandler: new DeliveryHandler({
        store: runtimeStore,
        adapters: matrixDelivery === undefined
          ? new Map()
          : new Map([["matrix", matrixDelivery]])
      })
    });
    const phases: LoopPhase[] = [
      subscriptionPhase(subscriptions),
      ...matrixPhases(matrixIngress),
      runtimePhase(runtimeCycle)
    ];
    handedOff = true;
    return {
      paths,
      matrixIngress,
      matrixDelivery,
      subscriptions,
      runtimeStore,
      loopControl,
      phases,
      agentNames: agentNames.sort(),
      roomIds: [...new Set(bindings.map((binding) => binding.roomId))].sort()
    };
  } finally {
    if (!handedOff) runtimeStore.close();
    registry.close();
    deviceStore.close();
  }
}

function subscriptionPhase(runtime: PollSubscriptionRuntime): LoopPhase {
  return {
    scope: "subscription",
    run: async (signal) => {
      const result = await runtime.runCycle(signal);
      return result.polled.length === 0 && result.fired.length === 0 &&
        result.failed.length === 0
        ? undefined
        : { type: "subscription.cycle", ...result };
    }
  };
}

function matrixPhases(ingress: MatrixIngress | undefined): LoopPhase[] {
  return (ingress?.bindingIds() ?? []).map((bindingId) => ({
    scope: "matrix",
    bindingId,
    run: async () => {
      const result = await ingress!.runCycle(bindingId);
      return result.scanned === 0
        ? undefined
        : { type: "matrix.ingress_cycle", ...result };
    }
  }));
}

function runtimePhase(runtime: RuntimeCycle): LoopPhase {
  return {
    scope: "runtime",
    run: async () => {
      const result = await runtime.run();
      return result.executions.length === 0 && result.deliveries.length === 0 &&
        result.failures.length === 0
        ? undefined
        : { type: "runtime.cycle", ...result };
    }
  };
}

class RoomHistoryRouter implements MatrixHistory {
  readonly #clients: ReadonlyMap<string, RoomServerClient>;

  public constructor(clients: ReadonlyMap<string, RoomServerClient>) {
    this.#clients = clients;
  }

  public head(roomId: string): Promise<RoomHead> {
    return this.#client(roomId).head(roomId);
  }

  public events(input: {
    readonly roomId: string;
    readonly after?: string;
    readonly through: string;
    readonly limit: number;
  }): Promise<RoomEventPage> {
    return this.#client(input.roomId).events(input);
  }

  #client(roomId: string): RoomServerClient {
    const client = this.#clients.get(roomId);
    if (client === undefined) throw new Error(`Room history client is missing: ${roomId}`);
    return client;
  }
}

function roomClient(
  credential: ActiveAgentCredential,
  fetchImplementation?: typeof fetch
): RoomServerClient {
  return new RoomServerClient({
    baseUrl: credential.serverUrl,
    agentId: credential.agentId,
    credential: credential.credential,
    allowInsecureHttp: new URL(credential.serverUrl).protocol === "http:",
    ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation })
  });
}

function requireExecutable(value: string | undefined, client: string): string {
  if (value === undefined) throw new Error(`${client} executable was not found in PATH`);
  return value;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
