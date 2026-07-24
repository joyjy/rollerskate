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
import {
  bootstrapLocalFoundation,
  LocalFoundationStore,
  type LocalAgent
} from "../application/local-foundation.js";
import { LocalChatStore } from "../application/local-chat-store.js";

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
  const runtimePathSet = runtimePaths(options.repoRoot, options.runtimeDirectory);
  mkdirSync(runtimePathSet.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(runtimePathSet.runtimeDirectory, 0o700);
  initializeRuntimeSchema(runtimePathSet.database);
  bootstrapLocalFoundation(runtimePathSet);
  const resources = await assembleRuntime(options);
  try {
    const reconciledAt = new Date().toISOString();
    resources.runtimeStore.reconcileInterrupted(reconciledAt);
    resources.subscriptions.reconcileInterrupted();
    return await runLoop({
      statePath: resources.paths.loopState,
      runtimeDirectory: resources.paths.runtimeDirectory,
      agentNames: resources.agentNames,
      routeIds: resources.routeIds,
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
        try {
          resources.runtimeStore.close();
        } finally {
          try {
            resources.localChat.close();
          } finally {
            resources.foundationStore.close();
          }
        }
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
  const foundationStore = new LocalFoundationStore(paths.database);
  const localChat = new LocalChatStore(paths.database);
  const runtimeStore = new RuntimeStore(paths.database);
  let handedOff = false;
  try {
    const device = deviceStore.current();
    const foundation = foundationStore.foundation();
    if (foundation === undefined) throw new Error("Local foundation is not initialized");
    const credentialStore = new AgentCredentialStore(paths.agentCredentials);
    const runtimeAgents = new Map<string, RuntimeAgentAdapter>();
    const publishers = new Map<string, RoomServerClient>();
    const roomClients = new Map<string, RoomServerClient>();
    const bindings = [];
    const roomPolicies = new RoomPolicyStore(paths.matrixPolicy);
    const loopControl = new LoopControlStore(paths.loopControl);
    const agentNames: string[] = [];
    for (const localAgent of foundationStore.listAgents().filter(
      (agent) => agent.status === "active"
    )) {
      agentNames.push(localAgent.handle);
      const adapter = runtimeAgent(localAgent, paths.workspace, options);
      runtimeAgents.set(
        localRuntimeAgentKey(localAgent.principalId, adapter.workspace),
        adapter
      );
    }
    for (const metadata of registry.list().filter((agent) => agent.status === "active")) {
      let agent: RuntimeAgentAdapter;
      try {
        agent = new CodexRuntimeAgent({
          executable: requireExecutable(options.codexExecutable, "Codex"),
          projectRoot: metadata.workspacePath,
          environment: options.environment,
          timeoutMilliseconds: options.codexTimeoutMilliseconds ?? 300_000
        });
      } catch (error) {
        options.output?.write(`${JSON.stringify({
          type: "runtime.adapter_unavailable",
          adapter: metadata.client,
          agentId: metadata.agentId,
          error: message(error)
        })}\n`);
        continue;
      }
      agentNames.push(metadata.name);
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
        ["agent", new AgentHandler({
          store: runtimeStore,
          adapterForAgent(agentId, sessionWorkspace) {
            const localAgent = foundationStore.listAgents().find(
              (agent) => agent.principalId === agentId
            );
            if (localAgent !== undefined) {
              if (localAgent.status !== "active") return undefined;
              const workspace = sessionWorkspace ?? paths.workspace;
              const key = localRuntimeAgentKey(agentId, workspace);
              const cached = runtimeAgents.get(key);
              if (cached !== undefined) return cached;
              const adapter = runtimeAgent(localAgent, workspace, options);
              runtimeAgents.set(key, adapter);
              return adapter;
            }
            return runtimeAgents.get(agentId);
          }
        })],
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
      localChatPhase(localChat, foundation.topicId, foundationStore),
      runtimePhase(runtimeCycle)
    ];
    handedOff = true;
    return {
      paths,
      matrixIngress,
      matrixDelivery,
      subscriptions,
      runtimeStore,
      localChat,
      foundationStore,
      loopControl,
      phases,
      agentNames: agentNames.sort(),
      routeIds: [
        foundation.topicId,
        ...new Set(bindings.map((binding) => binding.roomId))
      ].sort()
    };
  } finally {
    if (!handedOff) runtimeStore.close();
    registry.close();
    deviceStore.close();
    if (!handedOff) {
      localChat.close();
      foundationStore.close();
    }
  }
}

function runtimeAgent(
  agent: LocalAgent,
  workspace: string,
  options: RuntimeStartOptions
): RuntimeAgentAdapter {
  return new CodexRuntimeAgent({
    executable: requireExecutable(options.codexExecutable, "Codex"),
    projectRoot: workspace,
    environment: options.environment,
    timeoutMilliseconds: options.codexTimeoutMilliseconds ?? 300_000
  });
}

function localRuntimeAgentKey(agentId: string, workspace: string): string {
  return `local:${agentId}:${workspace}`;
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

function localChatPhase(
  chat: LocalChatStore,
  topicId: string,
  foundation: LocalFoundationStore
): LoopPhase {
  return {
    scope: "local-chat",
    run: async () => {
      const prompts = chat.promptPending(
        topicId,
        foundation.listAgents()
          .filter((agent) => agent.status === "active")
          .map((agent) => ({
            principalId: agent.principalId,
            handle: agent.handle
          }))
      );
      return prompts.length === 0
        ? undefined
        : {
            type: "local_chat.dispatch_prompted",
            messageEventIds: prompts.map((event) => event.eventId)
          };
    }
  };
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
