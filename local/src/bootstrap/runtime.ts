import { chmodSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  ConnectorReadRequest,
  ConnectorReadResult,
  RoomEventPage,
  RoomHead
} from "../protocol.js";
import { LoopControlStore } from "../infrastructure/files/loop-control-store.js";
import { RoomPolicyStore } from "../infrastructure/files/room-policy-store.js";
import { AgentCredentialStore, type ActiveAgentCredential } from "../infrastructure/files/agent-credential-store.js";
import { DeviceCredentialStore } from "../infrastructure/files/device-credential-store.js";
import { TopicInboxStore } from "../infrastructure/files/topic-inbox-store.js";
import { LocalDeviceStore } from "../infrastructure/files/device-binding-store.js";
import { PollProbeExecutor } from "../capabilities/subscription/plugin-runner.js";
import { SubscriptionRuntime } from "../capabilities/subscription/runtime.js";
import { ContinuousSubscriptionRuntime } from "../capabilities/subscription/continuous-runtime.js";
import { ProactiveCallbackRuntime } from "../application/callback/proactive-runtime.js";
import { proactiveCallbackOwnerAdapters } from "../application/callback/proactive.js";
import { HostCallbackKernel } from "../infrastructure/callback/host-kernel.js";
import { ScheduledTaskRuntime } from "../capabilities/scheduled-task/runtime.js";
import { ScheduledTaskStore } from "../capabilities/scheduled-task/store.js";
import { StewardModule } from "../application/steward/module.js";
import { AgentRunStore } from "../infrastructure/sqlite/agent-run-store.js";
import { openRuntimeDatabase } from "../infrastructure/sqlite/database.js";
import {
  AgentHandler,
  DeliveryHandler,
  ResultHandler,
  type RuntimeAgentAdapter,
  type RuntimeDestinationAdapter,
  type RuntimeEventHandler
} from "../core/runtime/handlers.js";
import type { RuntimeHandlerKind } from "../core/runtime/model.js";
import type { AgentInputEvent, ChatDispatchEvent } from "../core/event/model.js";
import { RuntimeCycle } from "../core/runtime/cycle.js";
import { RuntimeStore } from "../core/runtime/store.js";
import { runLoop, type LoopPhase, type LoopResult } from "../core/loop.js";
import {
  CODEX_CLIENT_HISTORY_POLICY_ENV,
  CodexRuntimeAgent
} from "../integrations/agent/codex.js";
import { ClaudeCodeRuntimeAgent } from "../integrations/agent/claude-code.js";
import { KimiCodeRuntimeAgent } from "../integrations/agent/kimi-code.js";
import { PiRuntimeAgent } from "../integrations/agent/pi.js";
import {
  MacOsNotificationAdapter,
  type MacOsNotificationRunner
} from "../integrations/notification/macos.js";
import {
  MatrixDeliveryAdapter,
  MatrixIngress,
  type MatrixHistory
} from "../integrations/matrix/runtime-adapter.js";
import { DeviceServerClient } from "../integrations/server/device-client.js";
import { AgentServerClient } from "../integrations/server/agent-client.js";
import { ServerTopicDeliveryAdapter } from "../integrations/server/topic-delivery.js";
import { VikunjaTaskDestinationAdapter } from
  "../integrations/vikunja/task-destination.js";
import { PassiveTopicSync } from "../application/topic/sync.js";
import { ServerTopicRuntimeBridge } from "../application/topic/runtime.js";
import {
  RoomServerClient,
  RoomServerPublisherRouter
} from "../integrations/server/room-client.js";
import { runtimePaths } from "../infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../infrastructure/sqlite/schema.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../infrastructure/sqlite/foundation-store.js";
import type { LocalAgent } from "../modules/foundation/model.js";
import { admitSameClientHistoryPolicy } from
  "../modules/agent/activity-policy.js";
import { LocalChatStore } from "../infrastructure/sqlite/chat-store.js";
import { ChatHandler } from "../application/chat/handler.js";
import {
  sameClientHistoryPolicyForAdapter,
  withChatHistoryContinuation
} from "../application/chat/agent-continuation.js";
import {
  boundedChatPromptHistory,
  chatTimelineFromStore
} from "../application/chat/query.js";
import {
  inspectClientHistoryAccess,
  queryClientHistory
} from "../application/activity/client-history.js";
import { RunProgressProjector } from
  "../application/runtime/progress.js";
import { materializeLocalTopicGovernance } from
  "../application/topic/governance-control.js";
import { TopicGovernanceAdmissionPolicy } from
  "../application/topic/admission.js";
import { TopicGovernanceStore } from
  "../infrastructure/sqlite/topic-governance-store.js";
import { FreeChatRuntime } from "../application/topic/free-chat-runtime.js";
import { TopicActivationScheduleRuntime } from
  "../application/topic/schedule-runtime.js";
import { InteractiveChannelRuntime } from
  "../application/channel/runtime.js";
import { serverExternalRefTriggerGuard } from
  "../application/external-resource/trigger-guard.js";
import { listWorkRequestTargets } from
  "../application/work-request/control.js";
import { AgentWorkRequestRuntime } from
  "../application/work-request/runtime.js";

export interface RuntimeStartOptions {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  readonly codexExecutable?: string;
  readonly claudeCodeExecutable?: string;
  readonly kimiCodeExecutable?: string;
  readonly piExecutable?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly vikunjaEndpoint?: string;
  readonly vikunjaToken?: string;
  readonly pollMilliseconds?: number;
  readonly codexTimeoutMilliseconds?: number;
  readonly output?: { readonly write: (text: string) => void };
  readonly fetch?: typeof fetch;
  readonly macOsNotificationRunner?: MacOsNotificationRunner;
  readonly connectorRead?: (request: ConnectorReadRequest) => Promise<ConnectorReadResult>;
}

const CLIENT_HISTORY_MCP_ENTRYPOINT = fileURLToPath(
  new URL("../entrypoints/mcp/client-history.js", import.meta.url)
);
const CHAT_HISTORY_MCP_ENTRYPOINT = fileURLToPath(
  new URL("../entrypoints/mcp/chat-history.js", import.meta.url)
);

export async function startRuntime(
  options: RuntimeStartOptions,
  signal: AbortSignal
): Promise<LoopResult> {
  const runtimePathSet = runtimePaths(options.repoRoot, options.runtimeDirectory);
  mkdirSync(runtimePathSet.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(runtimePathSet.runtimeDirectory, 0o700);
  initializeRuntimeSchema(runtimePathSet.database);
  bootstrapLocalFoundation(runtimePathSet);
  materializeLocalTopicGovernance(
    options.repoRoot,
    runtimePathSet.runtimeDirectory
  );
  const resources = await assembleRuntime(options);
  try {
    const reconciledAt = new Date().toISOString();
    resources.scheduledTaskStore.reconcileInterrupted(reconciledAt);
    resources.runtimeStore.reconcileInterrupted(reconciledAt);
    resources.subscriptions.reconcileInterrupted();
    resources.proactiveCallbacks.recover(reconciledAt);
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
      const settled = await resources.runtimeCycle.settle();
      if (options.output !== undefined && (
        settled.executions.length > 0 || settled.deliveries.length > 0 ||
        settled.failures.length > 0
      )) {
        options.output.write(`${JSON.stringify({ type: "runtime.cycle", ...settled })}\n`);
      }
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
              resources.scheduledTaskStore.close();
            } finally {
              try {
                resources.agentRunStore.close();
              } finally {
                try {
                  resources.runtimeDatabase.close();
                } finally {
                  try {
                    resources.localChat.close();
                  } finally {
                    try {
                      resources.topicGovernanceStore.close();
                    } finally {
                      try {
                        resources.freeChat.close();
                      } finally {
                        try {
                          resources.topicActivationSchedules.close();
                        } finally {
                          try {
                            resources.interactiveChannels.close();
                          } finally {
                            resources.foundationStore.close();
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
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
  const foundationStore = new LocalFoundationStore(paths.database);
  const localChat = new LocalChatStore(paths.database);
  const topicGovernanceStore = new TopicGovernanceStore(paths.database);
  const freeChat = new FreeChatRuntime(options.repoRoot, {
    runtimeDirectory: paths.runtimeDirectory
  });
  const topicActivationSchedules = new TopicActivationScheduleRuntime(
    options.repoRoot,
    { runtimeDirectory: paths.runtimeDirectory }
  );
  const interactiveChannels = new InteractiveChannelRuntime(options.repoRoot, {
    runtimeDirectory: paths.runtimeDirectory,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const runtimeDatabase = openRuntimeDatabase(paths.database);
  const runtimeStore = new RuntimeStore(runtimeDatabase);
  const scheduledTaskStore = new ScheduledTaskStore(paths.database);
  const agentRunStore = new AgentRunStore(runtimeDatabase);
  const foundation = foundationStore.foundation();
  if (foundation === undefined) throw new Error("Local foundation is not initialized");
  const deviceStore = new LocalDeviceStore(paths.deviceBinding, {
    deviceId: foundation.deviceId,
    deviceName: foundation.deviceName
  });
  let handedOff = false;
  try {
    const device = deviceStore.current();
    const credentialStore = new AgentCredentialStore(paths.agentCredentials);
    const inbox = new TopicInboxStore(paths.topicInbox);
    const deviceCredential = new DeviceCredentialStore(paths.deviceCredential).load();
    const externalRefGuard = deviceCredential === undefined || options.connectorRead === undefined
      ? undefined
      : serverExternalRefTriggerGuard({
          client: new DeviceServerClient({
            serverUrl: deviceCredential.serverUrl,
            credential: deviceCredential.credential,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch })
          }),
          connectorRead: options.connectorRead
        });
    const runtimeAgents = new Map<string, RuntimeAgentAdapter>();
    const publishers = new Map<string, RoomServerClient>();
    const topicPublishers = new Map<string, AgentServerClient>();
    const roomClients = new Map<string, RoomServerClient>();
    const bindings = [];
    const roomPolicies = new RoomPolicyStore(paths.matrixPolicy);
    const loopControl = new LoopControlStore(paths.loopControl);
    const continueChatHistory = (adapter: RuntimeAgentAdapter): RuntimeAgentAdapter =>
      withChatHistoryContinuation(adapter, {
        chatHistory: ({ topicId, beforeEventId, limit }) =>
          boundedChatPromptHistory(chatTimelineFromStore(localChat, topicId, {
            ...(beforeEventId === undefined ? {} : { beforeEventId }),
            limit
          })),
        clientHistory: (
          agentId,
          request,
          policyReceipt,
          currentProviderSessionId
        ) => queryClientHistory(
          options.repoRoot,
          agentId,
          request,
          {
            runtimeDirectory: paths.runtimeDirectory,
            ...(policyReceipt === undefined ? {} : { policyReceipt }),
            ...(currentProviderSessionId === undefined
              ? {}
              : { excludedProviderSessionId: currentProviderSessionId })
          }
        )
      });
    const agentNames: string[] = [];
    for (const localAgent of foundationStore.listAgents().filter(
      (agent) => agent.status === "active"
    )) {
      agentNames.push(localAgent.handle);
      try {
        const adapter = continueChatHistory(
          runtimeAgent(localAgent, paths.workspace, options)
        );
        runtimeAgents.set(
          localRuntimeAgentKey(localAgent, adapter.workspace),
          adapter
        );
        if (runtimeStore.reconcileCurrentLocalAgentSession(
          localAgent.principalId,
          adapter.adapterId,
          adapter.workspace
        )) {
          options.output?.write(`${JSON.stringify({
            type: "runtime.session_retired",
            agentId: localAgent.principalId,
            reason: "adapter-or-workspace-changed"
          })}\n`);
        }
      } catch (error) {
        options.output?.write(`${JSON.stringify({
          type: "runtime.adapter_unavailable",
          adapter: localAgent.client,
          agentId: localAgent.principalId,
          error: message(error)
        })}\n`);
      }
    }
    for (const localAgent of foundationStore.listAgents().filter(
      (agent) => agent.status === "active"
    )) {
      const credential = credentialStore.load(localAgent.handle);
      if (credential?.state !== "active" || device?.status !== "active" ||
        device.humanId === undefined) continue;
      const agent = runtimeAgents.get(localRuntimeAgentKey(localAgent, paths.workspace));
      if (agent === undefined) continue;
      runtimeAgents.set(credential.agentId, agent);
      const topicPublisher = new AgentServerClient({
        serverUrl: credential.serverUrl,
        agentId: credential.agentId,
        credential: credential.credential,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      });
      topicPublishers.set(credential.agentId, topicPublisher);
      let client: RoomServerClient;
      let summary: Awaited<ReturnType<AgentServerClient["principal"]>>;
      let remoteBindings: Awaited<ReturnType<RoomServerClient["bindings"]>>;
      try {
        client = roomClient(credential, options.fetch);
        summary = await topicPublisher.principal();
        remoteBindings = await client.bindings();
      } catch (error) {
        options.output?.write(`${JSON.stringify({
          type: "runtime.adapter_unavailable",
          adapter: "matrix",
          agentId: credential.agentId,
          error: message(error)
        })}\n`);
        continue;
      }
      publishers.set(credential.agentId, client);
      for (const binding of remoteBindings) {
        roomClients.set(binding.roomId, client);
        bindings.push({
          bindingId: binding.id,
          agentId: credential.agentId,
          agentName: localAgent.handle,
          credentialId: credential.credentialId,
          placementId: credential.placementId,
          roomId: binding.roomId,
          ownerHumanId: summary.owner.id,
          operatorHumanId: summary.operator.id,
          policy: roomPolicies.matrixPolicy(
            credential.agentId,
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
    const macOsNotification = new MacOsNotificationAdapter(
      options.macOsNotificationRunner
    );
    const deliveryAdapters = new Map<
      RuntimeDestinationAdapter["kind"],
      RuntimeDestinationAdapter
    >([["macos-notification", macOsNotification]]);
    if (matrixDelivery !== undefined) {
      deliveryAdapters.set("matrix", matrixDelivery);
    }
    if (topicPublishers.size > 0) {
      deliveryAdapters.set("server-topic", new ServerTopicDeliveryAdapter(topicPublishers));
    }
    const vikunjaEndpoint = options.vikunjaEndpoint?.trim();
    const vikunjaToken = options.vikunjaToken?.trim();
    if ((vikunjaEndpoint === undefined) !== (vikunjaToken === undefined)) {
      throw new Error(
        "Vikunja Task Delivery requires both ROLLERSKATE_VIKUNJA_URL and ROLLERSKATE_VIKUNJA_TOKEN"
      );
    }
    if (vikunjaEndpoint !== undefined && vikunjaToken !== undefined) {
      deliveryAdapters.set("vikunja-task", new VikunjaTaskDestinationAdapter({
        endpoint: vikunjaEndpoint,
        token: () => vikunjaToken,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      }));
    }
    const subscriptions = new SubscriptionRuntime({
      databasePath: paths.database,
      ...(externalRefGuard === undefined ? {} : { externalRefGuard }),
      probeExecutor: new PollProbeExecutor({
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      })
    });
    const continuousSubscriptions = new ContinuousSubscriptionRuntime({
      databasePath: paths.database,
      ...(externalRefGuard === undefined ? {} : { externalRefGuard }),
      probeExecutor: new PollProbeExecutor({
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      })
    });
    const callbackKernel = new HostCallbackKernel();
    const scheduledTasks = new ScheduledTaskRuntime({
      store: scheduledTaskStore,
      runtime: runtimeStore,
      validateTarget(revision) {
        const agent = foundationStore.agent(revision.agentId);
        if (agent === undefined) return "agent-not-found";
        if (agent.status !== "active") return "agent-suspended";
        if (revision.workspace !== foundation.workspacePath) {
          return "workspace-authority-mismatch";
        }
        if (revision.fixedSessionId !== undefined) {
          const session = runtimeStore.session(revision.fixedSessionId);
          if (session === undefined) return "fixed-session-not-found";
          if (session.agentId !== revision.agentId ||
            session.workspace !== revision.workspace) {
            return "fixed-session-target-mismatch";
          }
        }
        return undefined;
      },
      ...(externalRefGuard === undefined ? {} : { externalRefGuard })
    });
    const proactiveCallbacks = new ProactiveCallbackRuntime(paths.database, {
      ownerAdapters: proactiveCallbackOwnerAdapters(paths.database),
      kernel: callbackKernel
    });
    const adapterForAgent = (
      agentId: string,
      sessionWorkspace?: string
    ): RuntimeAgentAdapter | undefined => {
      const localAgent = foundationStore.listAgents().find(
        (agent) => agent.principalId === agentId
      );
      if (localAgent !== undefined) {
        if (localAgent.status !== "active") return undefined;
        const workspace = sessionWorkspace ?? paths.workspace;
        const key = localRuntimeAgentKey(localAgent, workspace);
        const cached = runtimeAgents.get(key);
        if (cached !== undefined) return cached;
        const adapter = continueChatHistory(runtimeAgent(localAgent, workspace, options));
        runtimeAgents.set(key, adapter);
        return adapter;
      }
      return runtimeAgents.get(agentId);
    };
    const steward = new StewardModule({
      runs: agentRunStore,
      runtime: runtimeStore
    });
    const modules = [steward.manifest()];
    const serverTopics = new ServerTopicRuntimeBridge({
      localTopicId: foundation.topicId,
      listAgents: () => foundationStore.listAgents(),
      serverAgentIdForHandle: (handle) => {
        const credential = credentialStore.load(handle);
        return credential?.state === "active" ? credential.agentId : undefined;
      },
      hasTopicPublisher: (serverAgentId) => topicPublishers.has(serverAgentId),
      inbox,
      chat: localChat
    });
    const topicAdmission = new TopicGovernanceAdmissionPolicy({
      getGovernance: (topicId) => topicGovernanceStore.get(topicId),
      listAgents: () => foundationStore.listAgents(),
      runtime: runtimeStore
    });
    const topicSync = deviceCredential === undefined
      ? undefined
      : new PassiveTopicSync({
          client: new DeviceServerClient({
            serverUrl: deviceCredential.serverUrl,
            credential: deviceCredential.credential,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch })
          }),
          inbox,
          participants: serverTopics.participants,
          admitHumanEvent: serverTopics.admitHumanEvent,
          admitAgentEvent: serverTopics.admitAgentEvent
        });
    const runtimeCycle = new RuntimeCycle({
      store: runtimeStore,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", new AgentHandler({
          store: runtimeStore,
          adapterForAgent,
          executionGuards: [
            ...modules.flatMap((module) => module.executionGuards),
            topicAdmission
          ],
          resolveChatReplyRoute: serverTopics.resolveChatReplyRoute
        })],
        ["result", new ResultHandler(
          runtimeStore,
          modules.flatMap((module) => module.resultContinuations)
        )],
        ["chat", new ChatHandler({
          store: runtimeStore,
          chat: localChat,
          listAgents: serverTopics.agentsForTopic,
          admissionPolicy: topicAdmission,
          resolveProfileContext: serverTopics.profileResolution,
          resolveClientHistory: (agentId) => {
            const grant = inspectClientHistoryAccess(options.repoRoot, agentId, {
              runtimeDirectory: paths.runtimeDirectory
            });
            if (grant?.status !== "active") return undefined;
            const adapter = adapterForAgent(agentId);
            const policy = adapter === undefined
              ? undefined
              : sameClientHistoryPolicyForAdapter(adapter);
            if (!(policy?.activityAccess === "same-client-history-read" &&
              policy.client === grant.client)) return undefined;
            return grant.client === "codex"
              ? {
                  schema: "ClientThreadToolsCapability@1",
                  scope: "same-client-history-read",
                  client: "codex",
                  tools: ["list_client_threads", "read_client_thread"] as const,
                  timeZone: "Asia/Shanghai" as const
                }
              : {
                  schema: "ClientHistoryCapability@1",
                  scope: "same-client-history-read",
                  client: grant.client,
                  actions: ["search", "read"]
                };
          },
          reportClientHistoryFailure: (agentId, error) => {
            options.output?.write(`${JSON.stringify({
              type: "runtime.client_history_unavailable",
              agentId,
              error: message(error)
            })}\n`);
          }
        })]
      ]),
      deliveryHandler: new DeliveryHandler({
        store: runtimeStore,
        adapters: deliveryAdapters
      })
    });
    const runProgress = new RunProgressProjector(
      options.repoRoot,
      paths.runtimeDirectory
    );
    const workRequests = new AgentWorkRequestRuntime({
      repoRoot: options.repoRoot,
      targets: listWorkRequestTargets(options.repoRoot, {
        runtimeDirectory: paths.runtimeDirectory,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      }).filter((target) => topicPublishers.has(target.serverAgentId)),
      dependencies: {
        runtimeDirectory: paths.runtimeDirectory,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      }
    });
    const phases: LoopPhase[] = [
      workRequestPhase(workRequests),
      subscriptionPhase(subscriptions),
      continuousSubscriptionPhase(continuousSubscriptions),
      ...topicSyncPhases(topicSync),
      ...matrixPhases(matrixIngress),
      scheduledTaskPhase(scheduledTasks),
      topicActivationSchedulePhase(topicActivationSchedules),
      freeChatPhase(freeChat),
      interactiveChannelPhase(interactiveChannels),
      proactiveCallbackPhase(proactiveCallbacks),
      runtimeProgressPhase(runProgress),
      runtimePhase(runtimeCycle)
    ];
    handedOff = true;
    return {
      paths,
      matrixIngress,
      matrixDelivery,
      subscriptions,
      proactiveCallbacks,
      runtimeCycle,
      scheduledTaskStore,
      agentRunStore,
      runtimeDatabase,
      runtimeStore,
      localChat,
      topicGovernanceStore,
      freeChat,
      topicActivationSchedules,
      interactiveChannels,
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
    if (!handedOff) {
      scheduledTaskStore.close();
      agentRunStore.close();
      runtimeStore.close();
      runtimeDatabase.close();
    }
    deviceStore.close();
    if (!handedOff) {
      localChat.close();
      topicGovernanceStore.close();
      freeChat.close();
      topicActivationSchedules.close();
      interactiveChannels.close();
      foundationStore.close();
    }
  }
}

function workRequestPhase(runtime: AgentWorkRequestRuntime): LoopPhase {
  return {
    scope: "agent-work-request",
    run: async () => {
      const result = await runtime.runCycle();
      return result.routed.length === 0 && result.recovered.length === 0 &&
        result.completed.length === 0 && result.failed.length === 0
        ? undefined
        : { type: "agent_work_request.cycle", routeId: runtime.routeId, ...result };
    }
  };
}

function runtimeProgressPhase(
  projector: RunProgressProjector
): LoopPhase {
  return {
    scope: "runtime.progress",
    run: async () => {
      const index = projector.refresh();
      if (index === undefined) return undefined;
      return {
        type: "runtime.progress_refreshed",
        runs: index.runs.length,
        runsTruncated: index.runsTruncated
      };
    }
  };
}

function topicSyncPhases(runtime: PassiveTopicSync | undefined): LoopPhase[] {
  return runtime === undefined ? [] : [{
    scope: "topic.passive-sync",
    run: async () => {
      const result = await runtime.syncOnce();
      return result.admitted === 0 ? undefined : {
        type: "topic.passive-sync",
        ...result
      };
    }
  }];
}

function continuousSubscriptionPhase(runtime: ContinuousSubscriptionRuntime): LoopPhase {
  return {
    scope: "subscription-continuous",
    run: async (signal) => {
      const result = await runtime.runCycle(signal);
      return Object.values(result).every((ids) => ids.length === 0)
        ? undefined
        : { type: "subscription.continuous_cycle", ...result };
    }
  };
}

function freeChatPhase(runtime: FreeChatRuntime): LoopPhase {
  return {
    scope: "topic.free-chat",
    run: async () => {
      const result = runtime.runCycle();
      return Object.values(result).every((ids) => ids.length === 0)
        ? undefined
        : { type: "topic.free_chat_cycle", ...result };
    }
  };
}

function topicActivationSchedulePhase(
  runtime: TopicActivationScheduleRuntime
): LoopPhase {
  return {
    scope: "topic.schedule",
    run: async () => {
      const result = runtime.runCycle();
      return Object.values(result).every((ids) => ids.length === 0)
        ? undefined
        : { type: "topic.schedule_cycle", ...result };
    }
  };
}

function interactiveChannelPhase(runtime: InteractiveChannelRuntime): LoopPhase {
  return {
    scope: "channel.interactive",
    run: async () => {
      const result = await runtime.runCycle();
      return Object.values(result).every((ids) => ids.length === 0)
        ? undefined
        : { type: "channel.interactive_cycle", ...result };
    }
  };
}

function proactiveCallbackPhase(runtime: ProactiveCallbackRuntime): LoopPhase {
  return {
    scope: "proactive-callback",
    run: async (signal) => {
      const result = await runtime.tick(signal);
      return result.reconciled === 0 && result.admitted.length === 0 &&
        result.succeeded.length === 0 && result.failed.length === 0
        ? undefined
        : { type: "proactive.callback_cycle", ...result };
    }
  };
}

function runtimeAgent(
  agent: LocalAgent,
  workspace: string,
  options: RuntimeStartOptions
): RuntimeAgentAdapter {
  return runtimeAgentForClient(
    agent.client,
    agent.executionConfig,
    workspace,
    options,
    agent.principalId
  );
}

function runtimeAgentForClient(
  client: LocalAgent["client"],
  executionConfig: LocalAgent["executionConfig"],
  workspace: string,
  options: RuntimeStartOptions,
  agentId?: string
): RuntimeAgentAdapter {
  const common = {
    projectRoot: workspace,
    environment: options.environment,
    timeoutMilliseconds: options.codexTimeoutMilliseconds ?? 300_000,
    launchArgs: executionConfig.launchArgs
  };
  switch (client) {
    case "codex":
      return new CodexRuntimeAgent({
        executable: requireExecutable(options.codexExecutable, "Codex"),
        ...common,
        ...(agentId === undefined
          ? {}
          : {
              resolveMcpServers: ({ event, providerSessionId, invocationStartedAt }) => {
                const servers = chatHistoryMcpServers(event, options);
                if (event.type !== "chat.dispatch") return servers;
                const grant = inspectClientHistoryAccess(options.repoRoot, agentId, {
                  ...(options.runtimeDirectory === undefined
                    ? {}
                    : { runtimeDirectory: options.runtimeDirectory })
                });
                if (grant?.status !== "active" || grant.client !== "codex") return servers;
                return [...servers, {
                  name: "rollerskate_client_history",
                  command: process.execPath,
                  args: [
                    CLIENT_HISTORY_MCP_ENTRYPOINT,
                    "--repo-root", options.repoRoot,
                    "--runtime-directory",
                    runtimePaths(options.repoRoot, options.runtimeDirectory).runtimeDirectory,
                    "--agent-id", agentId,
                    "--invocation-started-at", invocationStartedAt,
                    "--policy-environment-name", CODEX_CLIENT_HISTORY_POLICY_ENV,
                    ...(providerSessionId === undefined
                      ? []
                      : ["--provider-session-id", providerSessionId])
                  ]
                }];
              },
              serializeMcpPolicy: (observation) =>
                JSON.stringify(admitSameClientHistoryPolicy(observation))
            })
      });
    case "claude-code":
      return new ClaudeCodeRuntimeAgent({
        executable: requireExecutable(options.claudeCodeExecutable, "Claude Code"),
        ...common,
        resolveMcpServers: ({ event }) => chatHistoryMcpServers(event, options)
      });
    case "kimi-code":
      return new KimiCodeRuntimeAgent({
        executable: requireExecutable(options.kimiCodeExecutable, "Kimi Code"),
        ...common,
        timeoutMilliseconds: Math.max(common.timeoutMilliseconds, 900_000)
      });
    case "pi":
      return new PiRuntimeAgent({
        executable: requireExecutable(options.piExecutable, "pi"),
        ...common,
        resolveChatHistoryContext: ({ event }) => event.type === "chat.dispatch" &&
          event.sourceMessageEventId !== undefined
          ? {
              runtimeDirectory: runtimePaths(
                options.repoRoot,
                options.runtimeDirectory
              ).runtimeDirectory,
              topicId: event.topicId,
              sourceMessageEventId: event.sourceMessageEventId
            }
          : undefined
      });
  }
}

function chatHistoryMcpServers(
  event: AgentInputEvent | ChatDispatchEvent,
  options: RuntimeStartOptions
) {
  if (event.type !== "chat.dispatch" || event.sourceMessageEventId === undefined) return [];
  return [{
    name: "rollerskate_chat",
    command: process.execPath,
    args: [
      CHAT_HISTORY_MCP_ENTRYPOINT,
      "--runtime-directory",
      runtimePaths(options.repoRoot, options.runtimeDirectory).runtimeDirectory,
      "--topic-id", event.topicId,
      "--source-message-event-id", event.sourceMessageEventId
    ]
  }];
}

function localRuntimeAgentKey(agent: LocalAgent, workspace: string): string {
  return [
    "local",
    agent.principalId,
    workspace,
    agent.client,
    JSON.stringify(agent.executionConfig)
  ].join(":");
}

function subscriptionPhase(runtime: SubscriptionRuntime): LoopPhase {
  return {
    scope: "subscription",
    run: async (signal) => {
      const result = await runtime.runCycle(signal);
      return result.polled.length === 0 && result.failed.length === 0
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
      const result = runtime.poll();
      return result.executions.length === 0 && result.deliveries.length === 0 &&
        result.failures.length === 0
        ? undefined
        : { type: "runtime.cycle", ...result };
    }
  };
}

function scheduledTaskPhase(runtime: ScheduledTaskRuntime): LoopPhase {
  return {
    scope: "scheduled-task",
    run: async () => {
      const result = await runtime.runCycle();
      return Object.values(result).every((ids) => ids.length === 0)
        ? undefined
        : { type: "scheduled_task.cycle", ...result };
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
