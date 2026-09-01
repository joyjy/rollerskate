import { describe, expect, it } from "vitest";
import * as v from "valibot";

import {
  agentRunDecisionSchema,
  agentRunDecisionReceiptSchema,
  agentSummariesSchema,
  networkSafetyViewSchema,
  runtimeAuditSchema,
  subscriptionsSchema
} from "@/api/schema";

describe("agentRunDecisionSchema", () => {
  const common = {
    expectedRunVersion: 1,
    rationale: "one bounded step remains",
    checkedAcceptance: [],
    state: {
      schemaVersion: "OrchestratorState@1",
      goal: "complete the run",
      tasks: [],
      acceptedEvidence: [],
      unresolvedQuestions: []
    }
  };

  it("reads current v3 and persisted v2 step results, but not unrelated v1 input", () => {
    expect(v.safeParse(agentRunDecisionSchema, {
      ...common,
      schemaVersion: "RunDecision@3",
      action: "finish",
      finish: { scope: "run", outcome: "succeeded", summary: "done" }
    }).success).toBe(true);
    expect(v.safeParse(agentRunDecisionSchema, {
      ...common,
      schemaVersion: "RunDecision@2",
      action: "next_step",
      nextStep: {
        target: { kind: "agent", agentId: "prn_worker" },
        mandate: { kind: "objective", objective: "finish the task" }
      }
    }).success).toBe(true);
    expect(v.safeParse(agentRunDecisionSchema, {
      ...common,
      schemaVersion: "RunDecision@1",
      action: "needs_human"
    }).success).toBe(false);
  });
});

describe("agentRunDecisionReceiptSchema", () => {
  it("accepts active v2 and historical v1 decision receipts", () => {
    const common = {
      runId: "run_1",
      requestId: "decision_1",
      expectedRunVersion: 1,
      resultingRunVersion: 2,
      sourceStepId: "step_1",
      acceptedAt: "2026-08-28T04:00:00.000Z"
    };

    expect(v.safeParse(agentRunDecisionReceiptSchema, {
      ...common,
      schemaVersion: "AgentRunDecisionReceipt@2",
      action: "next_step",
      targetAgentId: "prn_worker",
      nextStepId: "step_2",
      nextEventId: "evt_2",
      nextExecutionId: "exe_2",
      resultingRunStatus: "active"
    }).success).toBe(true);
    expect(v.safeParse(agentRunDecisionReceiptSchema, {
      ...common,
      schemaVersion: "AgentRunDecisionReceipt@1",
      action: "finish",
      terminalStatus: "succeeded"
    }).success).toBe(true);
  });
});

describe("agentSummariesSchema", () => {
  it("accepts unknown Local Agent clients for forward-compatible display", () => {
    const result = v.safeParse(agentSummariesSchema, [{
      principalId: "prn_future",
      handle: "future-agent",
      status: "active",
      client: "future-client",
      executionConfig: { launchArgs: [] },
      availability: { state: "unknown" },
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z"
    }]);

    expect(result.success).toBe(true);
  });
});

describe("runtimeAuditSchema", () => {
  it("accepts a Chat decision receipt without a presence transition", () => {
    const result = v.safeParse(runtimeAuditSchema, {
      event: {
        eventId: "evt_dispatch",
        type: "chat.dispatch",
        source: { kind: "handler" },
        destinationIds: [],
        causality: { rootEventId: "evt_root", hop: 1 },
        createdAt: "2026-07-27T00:00:00.000Z"
      },
      deliveries: [],
      chat: {
        attentionReceipts: [],
        decisionReceipt: {
          dispatchEventId: "evt_dispatch",
          speechAction: "silent",
          createdAt: "2026-07-27T00:00:01.000Z"
        }
      },
      lifecycleChangedAt: "2026-07-27T00:00:01.000Z",
      reasonForIntervention: null,
      directChildren: [],
      causalityBoundary: null
    });

    expect(result.success).toBe(true);
  });
});

describe("v0.4 Console schemas", () => {
  it("accepts the Local-owned network safety projection", () => {
    const result = v.safeParse(networkSafetyViewSchema, {
      configuredServerUrl: "https://server.example",
      deviceLogin: { status: "idle" },
      device: {
        hasCredential: true,
        metadata: {
          deviceId: "dev_1",
          deviceName: "Laptop",
          serverUrl: "https://server.example",
          status: "active",
          humanId: "hum_1",
          humanDisplayName: "Owner"
        }
      },
      agents: [{
        agent: {
          principalId: "prn_1",
          handle: "alice",
          status: "active",
          client: "codex",
          executionConfig: { launchArgs: [] },
          availability: { state: "ready" },
          createdAt: "2026-07-27T00:00:00.000Z",
          updatedAt: "2026-07-27T00:00:00.000Z"
        },
        activityAccess: {
          agentId: "prn_1",
          scope: "owner-wide-read",
          status: "active",
          grantedAt: "2026-07-27T00:00:01.000Z",
          updatedAt: "2026-07-27T00:00:01.000Z"
        },
        profile: {
          agentId: "agt_1",
          displayName: "Alice",
          role: "Researcher",
          disclosure: "Automated agent",
          expressionRules: ["Label uncertainty."],
          revision: 3,
          updatedAt: "2026-07-27T00:00:02.000Z"
        }
      }],
      topics: [{
        topic: {
          id: "top_1",
          name: "Research",
          visibility: "public",
          profile: {
            purpose: "Bounded research",
            revision: 2,
            participationRules: ["Disclose automation."],
            expressionRules: ["Label uncertainty."]
          }
        },
        cursor: 12,
        syncedAt: "2026-07-27T00:00:03.000Z",
        participants: [],
        events: [{
          eventId: "tev_12",
          publisher: {
            kind: "agent",
            agentId: "agt_1",
            agentName: "alice",
            ownerHumanId: "hum_1",
            ownerDisplayName: "Alice",
            deviceId: "dev_1"
          },
          body: "Current finding",
          createdAt: "2026-07-27T00:00:03.000Z"
        }, {
          eventId: "tev_13",
          publisher: {
            kind: "human",
            humanId: "hum_1",
            displayName: "Owner",
            deviceId: "dev_1"
          },
          body: "Human question",
          createdAt: "2026-07-27T00:00:04.000Z"
        }]
      }]
    });

    expect(result.success).toBe(true);
  });

  it("accepts a Free Subscription with exact callback grant and unknown receipt state", () => {
    const result = v.safeParse(subscriptionsSchema, { items: [{
      kind: "free",
      id: "sub_1",
      title: "Observe build",
      status: "completed",
      owner: { agentId: "prn_1", handle: "alice", client: "codex" },
      definition: {
        schema: "SubscriptionDefinition@3",
        revision: "rev_1",
        digest: "sha256:def",
        callbackPhaseStatus: "completed_with_unknown",
        artifactRevision: "probe_1",
        artifactDigest: "sha256:probe",
        callbacks: [{
          callbackId: "cb_1",
          kind: "destination.deliver",
          definition: { destinationId: "dst_1" },
          grant: { destinationId: "dst_1" }
        }]
      },
      callbacks: [{
        occurrenceId: "pcb_1",
        callbackId: "cb_1",
        ordinal: 0,
        kind: "destination.deliver",
        definition: { destinationId: "dst_1" },
        grant: { destinationId: "dst_1" },
        status: "unknown",
        invocationStatus: null,
        agentResult: null,
        lastError: "provider result was not durably observed"
      }],
      probe: {
        plugin: { id: "build", path: "/probe.ts", schemaVersion: 1 },
        policy: {
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      schedule: {
        intervalMilliseconds: 1_000,
        maxWaitMilliseconds: 60_000,
        maxAttempts: 60,
        attemptCount: 2,
        deadlineAt: "2026-07-27T00:01:00.000Z",
        nextPollAt: "2026-07-27T00:00:03.000Z"
      },
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:03.000Z",
      latestError: null,
      terminalObservation: { state: "passed" },
      archivedAt: null,
      availableActions: { archive: true, unarchive: false }
    }], total: 1, page: 1, pageSize: 20 });

    expect(result.success).toBe(true);
  });

  it("accepts a Continuous Subscription checkpoint and pending callback view", () => {
    const result = v.safeParse(subscriptionsSchema, { items: [{
      kind: "continuous",
      id: "sub_continuous",
      title: "Refresh live data",
      status: "active",
      owner: { agentId: "prn_1", handle: "alice", client: "codex" },
      definition: { schemaVersion: "ContinuousSubscriptionDefinition@1", revision: 1 },
      callbacks: [{
        occurrenceId: "pcb_continuous_1",
        callbackId: "refresh",
        ordinal: 0,
        kind: "command.exec",
        definition: {},
        grant: {},
        status: "succeeded",
        receipt: { outcome: "succeeded" }
      }],
      callbackOccurrenceKey: "revision:2",
      callbackSummary: {
        total: 1,
        pending: 0,
        started: 0,
        terminal: 1,
        unknown: 0
      },
      probe: {
        plugin: { id: "live", path: "/probe.mjs", schemaVersion: 1 },
        policy: {
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      pollCount: 3,
      nextPollAt: "2026-07-28T00:00:04.000Z",
      checkpointOccurrenceKey: "revision:2",
      checkpointObservation: { occurrenceKey: "revision:2" },
      pendingOccurrenceKey: null,
      pendingObservation: null,
      latestError: null,
      archivedAt: null,
      availableActions: { archive: false, unarchive: false },
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:03.000Z"
    }], total: 1, page: 1, pageSize: 20 });
    expect(result.success).toBe(true);
  });
});
