import type { Subscription } from "@/types/subscription";
import type { RuntimeAudit, RuntimeInfo } from "@/types/runtime";

export const mockSubscriptions: Subscription[] = [
  {
    id: "sub-2f8a9e1c",
    title: "Publish weekly review",
    status: "active",
    owner: { agentId: "prn-alice", handle: "alice", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-1111",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: "ses_1111-2222",
      prompt: "任务完成后，总结当前 Room 上下文并给出下一步建议。"
    },
    probe: {
      plugin: { id: "task-completed", path: "examples/plugins/task-completed.ts", schemaVersion: 1 },
      policy: {
        allowedHttpOrigins: ["https://tracker.example.com"],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 5000,
        maxOutputBytes: 65536
      }
    },
    schedule: {
      intervalMilliseconds: 30000,
      maxWaitMilliseconds: 86400000,
      maxAttempts: 2880,
      attemptCount: 12,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-23T04:38:10Z"
    },
    createdAt: "2026-07-21T09:12:00Z",
    updatedAt: "2026-07-21T09:12:00Z",
    fireEventId: null,
    latestError: null
  },
  {
    id: "sub-9b4d21f7",
    title: "Verify bug fix",
    status: "paused",
    owner: { agentId: "prn-bob", handle: "bob", client: "claude-code" },
    callback: {
      providerSessionId: "provider-claude-3333",
      adapterId: "claude-code-runtime-json-v1",
      workspace: "/workspace",
      localSessionId: "ses_3333-4444",
      prompt: "Bug 修复后，在 Room 中更新进展。"
    },
    probe: {
      plugin: { id: "task-completed", path: "examples/plugins/task-completed.ts", schemaVersion: 1 },
      policy: {
        allowedHttpOrigins: ["https://tracker.example.com"],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 5000,
        maxOutputBytes: 65536
      }
    },
    schedule: {
      intervalMilliseconds: 60000,
      maxWaitMilliseconds: 172800000,
      maxAttempts: 2880,
      attemptCount: 8,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-21T08:30:00Z"
    },
    createdAt: "2026-07-20T16:45:00Z",
    updatedAt: "2026-07-21T08:30:00Z",
    fireEventId: null,
    latestError: null
  },
  {
    id: "sub-77e3c5a0",
    title: "Watch deployment",
    status: "running",
    owner: { agentId: "prn-alice", handle: "alice", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-1111",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: "ses_1111-2222",
      prompt: "任务完成后，总结当前 Room 上下文并给出下一步建议。"
    },
    probe: {
      plugin: { id: "task-completed", path: "examples/plugins/task-completed.ts", schemaVersion: 1 },
      policy: {
        allowedHttpOrigins: ["https://tracker.example.com"],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 5000,
        maxOutputBytes: 65536
      }
    },
    schedule: {
      intervalMilliseconds: 30000,
      maxWaitMilliseconds: 86400000,
      maxAttempts: 2880,
      attemptCount: 3,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-21T10:05:00Z"
    },
    createdAt: "2026-07-21T07:00:00Z",
    updatedAt: "2026-07-21T10:05:00Z",
    fireEventId: null,
    latestError: "Plugin probe timed out after 5000ms"
  },
  {
    id: "sub-11aa88dd",
    title: "Deployment completed",
    status: "completed",
    owner: { agentId: "prn-carol", handle: "carol", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-5555",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: "ses_5555-6666",
      prompt: "部署任务完成后，输出部署摘要。"
    },
    probe: {
      plugin: { id: "task-completed", path: "examples/plugins/task-completed.ts", schemaVersion: 1 },
      policy: {
        allowedHttpOrigins: ["https://tracker.example.com"],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 5000,
        maxOutputBytes: 65536
      }
    },
    schedule: {
      intervalMilliseconds: 60000,
      maxWaitMilliseconds: 86400000,
      maxAttempts: 1440,
      attemptCount: 1440,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-20T09:10:00Z"
    },
    createdAt: "2026-07-19T14:20:00Z",
    updatedAt: "2026-07-20T09:10:00Z",
    fireEventId: "evt-subscription-fire-3300",
    latestError: null
  },
  {
    id: "sub-cc4433aa",
    title: "Investigate provider state",
    status: "unknown",
    owner: { agentId: "prn-alice", handle: "alice", client: "codex" },
    callback: {
      providerSessionId: "provider-codex-1111",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      localSessionId: null,
      prompt: "任务完成后，总结当前 Room 上下文并给出下一步建议。"
    },
    probe: {
      plugin: { id: "task-completed", path: "examples/plugins/task-completed.ts", schemaVersion: 1 },
      policy: {
        allowedHttpOrigins: ["https://tracker.example.com"],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 5000,
        maxOutputBytes: 65536
      }
    },
    schedule: {
      intervalMilliseconds: 30000,
      maxWaitMilliseconds: 86400000,
      maxAttempts: 2880,
      attemptCount: 2,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-21T09:45:00Z"
    },
    createdAt: "2026-07-21T06:00:00Z",
    updatedAt: "2026-07-21T09:50:00Z",
    fireEventId: null,
    latestError: "Provider result unknown: task status reported completed but continuation did not finish"
  },
  {
    id: "sub-55ff1122",
    title: "Cancelled review",
    status: "cancelled",
    owner: { agentId: "prn-bob", handle: "bob", client: "claude-code" },
    callback: {
      providerSessionId: "provider-claude-3333",
      adapterId: "claude-code-runtime-json-v1",
      workspace: "/workspace",
      localSessionId: "ses_3333-4444",
      prompt: "任务取消后不再续接。"
    },
    probe: {
      plugin: { id: "task-completed", path: "examples/plugins/task-completed.ts", schemaVersion: 1 },
      policy: {
        allowedHttpOrigins: ["https://tracker.example.com"],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 5000,
        maxOutputBytes: 65536
      }
    },
    schedule: {
      intervalMilliseconds: 60000,
      maxWaitMilliseconds: 172800000,
      maxAttempts: 2880,
      attemptCount: 4,
      deadlineAt: "2026-08-22T00:00:00Z",
      nextPollAt: "2026-07-19T10:20:00Z"
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
    phase: "idle",
    totalCycles: 18492,
    lastCycleStartAt: "2026-07-23T04:37:58Z",
    lastCycleEndAt: "2026-07-23T04:37:59Z",
    lastCycleDurationMs: 340,
    currentPhaseSummary: null
  },
  controls: {
    pause: true,
    resume: false,
    recover: false
  },
  workload: {
    state: "queued",
    ready: 2,
    running: 0,
    retrying: 2,
    total: 4,
    asOf: "2026-07-23T04:38:00Z"
  },
  failures: [
    {
      failureRef: "fnd-sub-77e3c5a0",
      owner: "subscription",
      severity: "error",
      reason: "Plugin probe timed out after 5000ms",
      objectRef: "sub-77e3c5a0",
      eventId: "evt-sub-77e3c5a0",
      relatedRef: "inv-c8f2",
      occurredAt: "2026-07-23T04:12:00Z",
      action: {
        kind: "inspect",
        available: true,
        consoleRoute: "/console/events?eventId=evt-sub-77e3c5a0",
        cliHint: "rs event trace evt-sub-77e3c5a0"
      }
    },
    {
      failureRef: "fnd-result-44bb",
      owner: "notice",
      severity: "error",
      reason: "Matrix delivery returned 503",
      objectRef: "dest-room-deploy",
      eventId: "evt-result-44bb",
      relatedRef: "res-44bb",
      occurredAt: "2026-07-23T03:55:00Z",
      action: {
        kind: "inspect",
        available: true,
        consoleRoute: "/console/events?eventId=evt-result-44bb",
        cliHint: "rs event trace evt-result-44bb"
      }
    }
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
      output: "今天完成了 任务追踪器中的 task-8842 的初步拆解，剩余 task-5521 仍在处理。",
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
      eventId: "evt-tracker-5521-3",
      type: "subscription.fire",
      source: { kind: "subscription", externalId: "sub-77e3c5a0" },
      agentId: "agent-1",
      prompt: "任务完成后，总结当前 Room 上下文并给出下一步建议。",
      boundedPromptSummary: "总结 Room 上下文并给出下一步建议",
      sessionId: "sess-1111-2222",
      destinationIds: ["task-xyz-123"],
      causality: { rootEventId: "evt-tracker-5521-3", hop: 0 },
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
      adapterId: "claude-code",
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
