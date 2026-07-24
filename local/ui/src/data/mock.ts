import type { Subscription } from "@/types/subscription";
import type { RuntimeAudit, RuntimeInfo } from "@/types/runtime";

export const mockSubscriptions: Subscription[] = [
  {
    id: "sub-2f8a9e1c",
    status: "active",
    owner: { agentId: "prn-alice", handle: "alice", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-1111",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: "ses_1111-2222",
      prompt: "任务完成后，总结当前 Room 上下文并给出下一步建议。"
    },
    plugin: { id: "ticktick-completed", path: "examples/plugins/ticktick.ts", schemaVersion: 1 },
    schedule: {
      intervalMilliseconds: 30000,
      maxWaitMilliseconds: 86400000,
      maxAttempts: 2880,
      attemptCount: 12,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-23T04:38:10Z"
    },
    executionPolicy: {
      allowedHttpOrigins: ["https://api.ticktick.com"],
      allowedExecutables: [],
      allowedEnvironment: [],
      timeoutMilliseconds: 5000,
      maxOutputBytes: 65536
    },
    createdAt: "2026-07-21T09:12:00Z",
    updatedAt: "2026-07-21T09:12:00Z",
    fireEventId: null,
    latestError: null
  },
  {
    id: "sub-9b4d21f7",
    status: "paused",
    owner: { agentId: "prn-bob", handle: "bob", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-3333",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: "ses_3333-4444",
      prompt: "Bug 修复后，在 Room 中更新进展。"
    },
    plugin: { id: "ticktick-completed", path: "examples/plugins/ticktick.ts", schemaVersion: 1 },
    schedule: {
      intervalMilliseconds: 60000,
      maxWaitMilliseconds: 172800000,
      maxAttempts: 2880,
      attemptCount: 8,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-21T08:30:00Z"
    },
    executionPolicy: {
      allowedHttpOrigins: ["https://api.ticktick.com"],
      allowedExecutables: [],
      allowedEnvironment: [],
      timeoutMilliseconds: 5000,
      maxOutputBytes: 65536
    },
    createdAt: "2026-07-20T16:45:00Z",
    updatedAt: "2026-07-21T08:30:00Z",
    fireEventId: null,
    latestError: null
  },
  {
    id: "sub-77e3c5a0",
    status: "running",
    owner: { agentId: "prn-alice", handle: "alice", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-1111",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: "ses_1111-2222",
      prompt: "任务完成后，总结当前 Room 上下文并给出下一步建议。"
    },
    plugin: { id: "ticktick-completed", path: "examples/plugins/ticktick.ts", schemaVersion: 1 },
    schedule: {
      intervalMilliseconds: 30000,
      maxWaitMilliseconds: 86400000,
      maxAttempts: 2880,
      attemptCount: 3,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-21T10:05:00Z"
    },
    executionPolicy: {
      allowedHttpOrigins: ["https://api.ticktick.com"],
      allowedExecutables: [],
      allowedEnvironment: [],
      timeoutMilliseconds: 5000,
      maxOutputBytes: 65536
    },
    createdAt: "2026-07-21T07:00:00Z",
    updatedAt: "2026-07-21T10:05:00Z",
    fireEventId: null,
    latestError: "Plugin probe timed out after 5000ms"
  },
  {
    id: "sub-11aa88dd",
    status: "completed",
    owner: { agentId: "prn-carol", handle: "carol", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-5555",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: "ses_5555-6666",
      prompt: "部署任务完成后，输出部署摘要。"
    },
    plugin: { id: "ticktick-completed", path: "examples/plugins/ticktick.ts", schemaVersion: 1 },
    schedule: {
      intervalMilliseconds: 60000,
      maxWaitMilliseconds: 86400000,
      maxAttempts: 1440,
      attemptCount: 1440,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-20T09:10:00Z"
    },
    executionPolicy: {
      allowedHttpOrigins: ["https://api.ticktick.com"],
      allowedExecutables: [],
      allowedEnvironment: [],
      timeoutMilliseconds: 5000,
      maxOutputBytes: 65536
    },
    createdAt: "2026-07-19T14:20:00Z",
    updatedAt: "2026-07-20T09:10:00Z",
    fireEventId: "evt-subscription-fire-3300",
    latestError: null
  },
  {
    id: "sub-cc4433aa",
    status: "unknown",
    owner: { agentId: "prn-alice", handle: "alice", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-1111",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: null,
      prompt: "任务完成后，总结当前 Room 上下文并给出下一步建议。"
    },
    plugin: { id: "ticktick-completed", path: "examples/plugins/ticktick.ts", schemaVersion: 1 },
    schedule: {
      intervalMilliseconds: 30000,
      maxWaitMilliseconds: 86400000,
      maxAttempts: 2880,
      attemptCount: 2,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-21T09:45:00Z"
    },
    executionPolicy: {
      allowedHttpOrigins: ["https://api.ticktick.com"],
      allowedExecutables: [],
      allowedEnvironment: [],
      timeoutMilliseconds: 5000,
      maxOutputBytes: 65536
    },
    createdAt: "2026-07-21T06:00:00Z",
    updatedAt: "2026-07-21T09:50:00Z",
    fireEventId: null,
    latestError: "Provider result unknown: task status reported completed but continuation did not finish"
  },
  {
    id: "sub-55ff1122",
    status: "cancelled",
    owner: { agentId: "prn-bob", handle: "bob", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-3333",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: "ses_3333-4444",
      prompt: "任务取消后不再续接。"
    },
    plugin: { id: "ticktick-completed", path: "examples/plugins/ticktick.ts", schemaVersion: 1 },
    schedule: {
      intervalMilliseconds: 60000,
      maxWaitMilliseconds: 172800000,
      maxAttempts: 2880,
      attemptCount: 4,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-19T10:20:00Z"
    },
    executionPolicy: {
      allowedHttpOrigins: ["https://api.ticktick.com"],
      allowedExecutables: [],
      allowedEnvironment: [],
      timeoutMilliseconds: 5000,
      maxOutputBytes: 65536
    },
    createdAt: "2026-07-18T11:00:00Z",
    updatedAt: "2026-07-19T10:20:00Z",
    fireEventId: null,
    latestError: null
  }
];

export const mockRuntimeInfo: RuntimeInfo = {
  status: "running",
  statusReason: "Loop 在 freshness window 内持续推进；Matrix delivery 局部降级未影响整体推进。",
  recommendedAction: "无需立即操作。如需处理失败 Delivery，请下钻到 Event 页或 Subscription 页。",
  statusSince: "2026-07-23T02:15:00Z",
  version: "0.3.0",
  runtimeRoot: "/runtime",
  workspaceRoot: "/workspace",
  pid: 48291,
  startedAt: "2026-07-23T02:15:00Z",
  schemaVersion: 3,
  consoleAddress: "127.0.0.1:4300",
  lastRefreshedAt: "2026-07-23T04:38:00Z",
  stale: false,
  loop: {
    state: "idle",
    totalCycles: 18492,
    lastCycleStartAt: "2026-07-23T04:37:58Z",
    lastCycleEndAt: "2026-07-23T04:37:59Z",
    lastCycleDurationMs: 340,
    nextCycleAt: "2026-07-23T04:38:03Z",
    inCycle: false,
    currentPhaseSummary: null
  },
  workload: {
    queuedExecutions: 1,
    runningExecutions: 0,
    retryWaitExecutions: 2,
    failedExecutions: 1,
    agentResultSucceeded: 47,
    agentResultFailed: 2,
    pendingDeliveries: 1,
    retryingDeliveries: 0,
    failedDeliveries: 1
  },
  recentIsolations: [
    {
      occurredAt: "2026-07-23T04:12:00Z",
      eventId: "evt-sub-77e3c5a0",
      executionId: "inv-c8f2",
      subscriptionId: "sub-77e3c5a0",
      boundedError: "Plugin probe timed out after 5000ms",
      loopContinued: true
    },
    {
      occurredAt: "2026-07-23T03:55:00Z",
      eventId: "evt-result-44bb",
      executionId: "res-44bb",
      destinationId: "dest-room-deploy",
      boundedError: "Matrix delivery returned 503",
      loopContinued: true
    }
  ],
  agents: { registered: 3, callable: 3, unavailable: 0 },
  events: { lastReceivedAt: "2026-07-23T04:37:45Z", waiting: 1, running: 0, succeeded: 47, failed: 3 },
  sessions: { total: 4, lastResumedAt: "2026-07-23T04:20:00Z", mismatched: 0 },
  subscriptions: { active: 3, paused: 1, expired: 0, failedUnknown: 1 },
  destinations: { available: 3, pending: 1, retrying: 0, failed: 1 },
  capabilities: [
    { name: "Poll Subscription", version: "0.3.0", available: true }
  ],
  integrations: [
    { name: "Codex Desktop adapter", kind: "adapter", status: "connected", lastSuccessAt: "2026-07-23T04:37:30Z", failureReason: null },
    { name: "Matrix ingress", kind: "ingress", status: "connected", lastSuccessAt: "2026-07-23T04:37:45Z", failureReason: null },
    { name: "Matrix delivery", kind: "delivery", status: "degraded", lastSuccessAt: "2026-07-23T03:50:00Z", failureReason: "503 on !room-deploy:example.com" },
    { name: "Server control plane", kind: "control-plane", status: "connected", lastSuccessAt: "2026-07-23T04:30:00Z", failureReason: null }
  ],
  recentLogs: [
    { timestamp: "2026-07-23T04:37:59Z", level: "info", subsystem: "loop", message: "Cycle 18492 completed in 340ms", objectId: null },
    { timestamp: "2026-07-23T04:37:58Z", level: "debug", subsystem: "subscription", message: "Polled sub-2f8a9e1c: no change", objectId: "sub-2f8a9e1c" },
    { timestamp: "2026-07-23T04:37:56Z", level: "warn", subsystem: "delivery", message: "Retry 2/3 for failed Matrix delivery", objectId: "del-88aa" },
    { timestamp: "2026-07-23T04:37:45Z", level: "info", subsystem: "ingress", message: "Received agent.request from matrix", objectId: "evt-matrix-001" },
    { timestamp: "2026-07-23T04:37:30Z", level: "info", subsystem: "agent", message: "Agent handler completed", objectId: "inv-c8f2" },
    { timestamp: "2026-07-23T04:12:00Z", level: "error", subsystem: "subscription", message: "Plugin probe timed out after 5000ms", objectId: "sub-77e3c5a0" }
  ],
  controlResult: {
    kind: "recover",
    status: "succeeded",
    message: "Interrupted-work reconciliation completed at 04:05:00Z.",
    recovered: 2,
    leftUnknown: 1,
    failed: 0
  }
};

export const mockEventAudits: RuntimeAudit[] = [
  {
    event: {
      eventId: "evt-matrix-001",
      type: "agent.request",
      source: { kind: "matrix", externalId: "!room-planning:example.com/$abc" },
      agentId: "agent-1",
      prompt: "总结一下今天的任务进度",
      boundedPromptSummary: "总结今日任务进度",
      sessionId: "sess-1111-2222",
      destinationIds: ["!room-planning:example.com"],
      causality: { rootEventId: "evt-matrix-001", hop: 0 },
      createdAt: "2026-07-23T04:37:45Z"
    },
    execution: {
      executionId: "inv-matrix-001",
      handler: "agent",
      status: "succeeded",
      attemptCount: 1,
      maxAttempts: 3,
      firstStartedAt: "2026-07-23T04:37:45Z",
      lastAttemptAt: "2026-07-23T04:37:45Z",
      completedAt: "2026-07-23T04:37:48Z",
      nextAttemptAt: "2026-07-23T04:37:45Z"
    },
    resultEvent: {
      eventId: "evt-result-matrix-001",
      type: "agent.result",
      outcome: "succeeded",
      sessionId: "sess-1111-2222",
      output: "今天完成了 ticktick 任务 task-8842 的初步拆解，剩余 task-5521 仍在处理。",
      causality: { rootEventId: "evt-matrix-001", parentEventId: "evt-matrix-001", hop: 1 },
      createdAt: "2026-07-23T04:37:48Z"
    },
    resultExecution: {
      executionId: "res-matrix-001",
      handler: "result",
      status: "succeeded",
      attemptCount: 1,
      maxAttempts: 3,
      firstStartedAt: "2026-07-23T04:37:48Z",
      lastAttemptAt: "2026-07-23T04:37:48Z",
      completedAt: "2026-07-23T04:37:50Z",
      nextAttemptAt: "2026-07-23T04:37:50Z"
    },
    session: {
      sessionId: "sess-1111-2222",
      agentId: "agent-1",
      adapterId: "codex-desktop",
      providerSessionId: "prov-sess-alice-001",
      workspace: "/workspace/planning",
      createdAt: "2026-07-20T10:00:00Z",
      resumedAt: "2026-07-23T04:37:45Z"
    },
    deliveries: [
      {
        delivery: {
          deliveryId: "del-matrix-001",
          resultEventId: "evt-result-matrix-001",
          status: "delivered",
          attemptCount: 1,
          source: "Matrix Room !room-planning:example.com",
          createdAt: "2026-07-23T04:37:50Z",
          attemptedAt: "2026-07-23T04:37:50Z",
          deliveredAt: "2026-07-23T04:37:51Z",
          receipt: "m.chat.message/$xyz"
        },
        destination: {
          destinationId: "!room-planning:example.com",
          kind: "matrix",
          address: { topicId: "!room-planning:example.com" }
        }
      }
    ],
    lifecycleChangedAt: "2026-07-23T04:37:51Z",
    reasonForIntervention: null,
    directChildren: [],
    causalityBoundary: null
  },
  {
    event: {
      eventId: "evt-subscription-fire-3300",
      type: "subscription.fire",
      source: { kind: "subscription", externalId: "sub-11aa88dd" },
      agentId: "agent-3",
      prompt: "部署任务完成后，输出部署摘要。",
      boundedPromptSummary: "输出部署摘要",
      sessionId: "sess-5555-6666",
      destinationIds: ["!room-deploy:example.com"],
      causality: { rootEventId: "evt-subscription-fire-3300", hop: 0 },
      createdAt: "2026-07-20T09:00:00Z"
    },
    execution: {
      executionId: "inv-44bb",
      handler: "agent",
      status: "succeeded",
      attemptCount: 1,
      maxAttempts: 1,
      firstStartedAt: "2026-07-20T09:00:05Z",
      lastAttemptAt: "2026-07-20T09:00:05Z",
      completedAt: "2026-07-20T09:00:08Z",
      nextAttemptAt: "2026-07-20T09:00:05Z"
    },
    resultEvent: {
      eventId: "evt-result-44bb",
      type: "agent.result",
      outcome: "succeeded",
      sessionId: "sess-5555-6666",
      output: "部署摘要：服务 v1.2.3 已发布至 staging，健康检查通过。",
      causality: { rootEventId: "evt-subscription-fire-3300", parentEventId: "evt-subscription-fire-3300", hop: 1 },
      createdAt: "2026-07-20T09:00:08Z"
    },
    resultExecution: {
      executionId: "res-44bb",
      handler: "result",
      status: "failed",
      attemptCount: 3,
      maxAttempts: 3,
      firstStartedAt: "2026-07-20T09:00:08Z",
      lastAttemptAt: "2026-07-20T09:09:00Z",
      completedAt: "2026-07-20T09:10:00Z",
      nextAttemptAt: "2026-07-20T09:10:00Z",
      lastError: "Matrix delivery returned 503"
    },
    session: {
      sessionId: "sess-5555-6666",
      agentId: "agent-3",
      adapterId: "codex-desktop",
      providerSessionId: "prov-sess-carol-001",
      workspace: "/workspace/deploy",
      createdAt: "2026-07-19T14:00:00Z",
      resumedAt: "2026-07-20T09:00:00Z"
    },
    deliveries: [
      {
        delivery: {
          deliveryId: "del-88aa",
          resultEventId: "evt-result-44bb",
          status: "failed",
          attemptCount: 3,
          source: "Matrix Room !room-deploy:example.com",
          createdAt: "2026-07-20T09:00:08Z",
          attemptedAt: "2026-07-20T09:09:00Z",
          deliveredAt: null,
          boundedError: "503 on !room-deploy:example.com",
          lastError: "503 on !room-deploy:example.com"
        },
        destination: {
          destinationId: "!room-deploy:example.com",
          kind: "matrix",
          address: { topicId: "!room-deploy:example.com" }
        }
      }
    ],
    lifecycleChangedAt: "2026-07-20T09:10:00Z",
    reasonForIntervention: "Delivery failed after max retries; inspect Destination in Event detail.",
    directChildren: [],
    causalityBoundary: null
  },
  {
    event: {
      eventId: "evt-ticktick-5521-3",
      type: "subscription.fire",
      source: { kind: "subscription", externalId: "sub-77e3c5a0" },
      agentId: "agent-1",
      prompt: "任务完成后，总结当前 Room 上下文并给出下一步建议。",
      boundedPromptSummary: "总结 Room 上下文并给出下一步建议",
      sessionId: "sess-1111-2222",
      destinationIds: ["task-xyz-123"],
      causality: { rootEventId: "evt-ticktick-5521-3", hop: 0 },
      createdAt: "2026-07-21T10:05:00Z"
    },
    execution: {
      executionId: "inv-c8f2",
      handler: "agent",
      status: "running",
      attemptCount: 1,
      maxAttempts: 1,
      firstStartedAt: "2026-07-21T10:05:02Z",
      lastAttemptAt: "2026-07-21T10:05:02Z",
      completedAt: null,
      nextAttemptAt: "2026-07-21T10:05:02Z"
    },
    resultEvent: undefined,
    resultExecution: undefined,
    session: {
      sessionId: "sess-1111-2222",
      agentId: "agent-1",
      adapterId: "codex-desktop",
      providerSessionId: "prov-sess-alice-001",
      workspace: "/workspace/planning",
      createdAt: "2026-07-20T10:00:00Z",
      resumedAt: "2026-07-21T10:05:00Z"
    },
    deliveries: [],
    lifecycleChangedAt: "2026-07-21T10:05:02Z",
    reasonForIntervention: null,
    directChildren: [],
    causalityBoundary: null
  },
  {
    event: {
      eventId: "evt-cli-001",
      type: "agent.request",
      source: { kind: "cli", externalId: "rs-cli-7d3c" },
      agentId: "agent-2",
      prompt: "检查 bug 修复状态",
      boundedPromptSummary: "检查 bug 修复状态",
      sessionId: undefined,
      destinationIds: [],
      causality: { rootEventId: "evt-cli-001", hop: 0 },
      createdAt: "2026-07-21T08:15:00Z"
    },
    execution: {
      executionId: "inv-cli-001",
      handler: "agent",
      status: "failed",
      attemptCount: 3,
      maxAttempts: 3,
      firstStartedAt: "2026-07-21T08:15:00Z",
      lastAttemptAt: "2026-07-21T08:17:00Z",
      completedAt: "2026-07-21T08:17:00Z",
      nextAttemptAt: "2026-07-21T08:15:00Z",
      lastError: "Agent adapter unreachable"
    },
    resultEvent: undefined,
    resultExecution: undefined,
    session: undefined,
    deliveries: [],
    lifecycleChangedAt: "2026-07-21T08:17:00Z",
    reasonForIntervention: "Agent adapter unreachable; check Agent page before retry.",
    directChildren: [],
    causalityBoundary: null
  },
  {
    event: {
      eventId: "evt-retry-001",
      type: "agent.request",
      source: { kind: "matrix", externalId: "!room-bugs:example.com/$retry" },
      agentId: "agent-2",
      prompt: "重试上次失败的查询",
      boundedPromptSummary: "重试上次失败的查询",
      sessionId: "sess-3333-4444",
      destinationIds: ["!room-bugs:example.com"],
      causality: { rootEventId: "evt-retry-001", hop: 0 },
      createdAt: "2026-07-23T03:50:00Z"
    },
    execution: {
      executionId: "inv-retry-001",
      handler: "agent",
      status: "retry_wait",
      attemptCount: 2,
      maxAttempts: 3,
      firstStartedAt: "2026-07-23T03:50:00Z",
      lastAttemptAt: "2026-07-23T03:55:00Z",
      completedAt: null,
      nextAttemptAt: "2026-07-23T04:05:00Z",
      lastError: "Rate limited by provider"
    },
    resultEvent: undefined,
    resultExecution: undefined,
    session: {
      sessionId: "sess-3333-4444",
      agentId: "agent-2",
      adapterId: "codex",
      providerSessionId: "prov-sess-bob-001",
      workspace: "/workspace/bugs",
      createdAt: "2026-07-19T09:00:00Z",
      resumedAt: "2026-07-23T03:50:00Z"
    },
    deliveries: [],
    lifecycleChangedAt: "2026-07-23T03:55:00Z",
    reasonForIntervention: "Provider rate limit; next retry scheduled automatically.",
    directChildren: [],
    causalityBoundary: null
  },
  {
    event: {
      eventId: "evt-queued-001",
      type: "agent.request",
      source: { kind: "server", externalId: "rs-server-push-9" },
      agentId: "agent-3",
      prompt: "分析最新部署日志",
      boundedPromptSummary: "分析最新部署日志",
      sessionId: undefined,
      destinationIds: [],
      causality: { rootEventId: "evt-queued-001", hop: 0 },
      createdAt: "2026-07-23T04:37:50Z"
    },
    execution: {
      executionId: "inv-queued-001",
      handler: "agent",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 3,
      firstStartedAt: "2026-07-23T04:37:50Z",
      lastAttemptAt: "2026-07-23T04:37:50Z",
      completedAt: null,
      nextAttemptAt: "2026-07-23T04:38:00Z"
    },
    resultEvent: undefined,
    resultExecution: undefined,
    session: undefined,
    deliveries: [],
    lifecycleChangedAt: "2026-07-23T04:37:50Z",
    reasonForIntervention: null,
    directChildren: [],
    causalityBoundary: null
  },
  {
    event: {
      eventId: "evt-child-001",
      type: "agent.result",
      source: { kind: "handler", externalId: "res-matrix-001" },
      agentId: "agent-1",
      boundedPromptSummary: "",
      sessionId: "sess-1111-2222",
      destinationIds: ["!room-planning:example.com"],
      causality: { rootEventId: "evt-matrix-001", parentEventId: "evt-matrix-001", hop: 1 },
      createdAt: "2026-07-23T04:37:48Z"
    },
    execution: {
      executionId: "res-matrix-001",
      handler: "result",
      status: "succeeded",
      attemptCount: 1,
      maxAttempts: 3,
      firstStartedAt: "2026-07-23T04:37:48Z",
      lastAttemptAt: "2026-07-23T04:37:48Z",
      completedAt: "2026-07-23T04:37:50Z",
      nextAttemptAt: "2026-07-23T04:37:50Z"
    },
    resultEvent: undefined,
    resultExecution: undefined,
    session: {
      sessionId: "sess-1111-2222",
      agentId: "agent-1",
      adapterId: "codex-desktop",
      providerSessionId: "prov-sess-alice-001",
      workspace: "/workspace/planning",
      createdAt: "2026-07-20T10:00:00Z",
      resumedAt: "2026-07-23T04:37:45Z"
    },
    deliveries: [
      {
        delivery: {
          deliveryId: "del-matrix-001",
          resultEventId: "evt-result-matrix-001",
          status: "delivered",
          attemptCount: 1,
          source: "Matrix Room !room-planning:example.com",
          createdAt: "2026-07-23T04:37:50Z",
          attemptedAt: "2026-07-23T04:37:50Z",
          deliveredAt: "2026-07-23T04:37:51Z",
          receipt: "m.chat.message/$xyz"
        },
        destination: {
          destinationId: "!room-planning:example.com",
          kind: "matrix",
          address: { topicId: "!room-planning:example.com" }
        }
      }
    ],
    lifecycleChangedAt: "2026-07-23T04:37:50Z",
    reasonForIntervention: null,
    directChildren: [],
    causalityBoundary: null
  }
];
