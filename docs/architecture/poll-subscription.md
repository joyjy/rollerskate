---
type: Architecture
title: Subscription
description: one-shot terminal 与 Continuous Subscription delta/checkpoint 的 source-owned 生命周期，以及 Run occurrence binding。
tags: [rollerskate, subscription, polling, run, trigger]
timestamp: 2026-07-30
---

# Subscription

[返回 architecture index](./index.md)

## 主路径

```text
Steward await_source registers SubscriptionDefinition@4
  -> validate admitted plugin ref, immutable probe artifact, policy and RunSourceBinding@1
  -> persist definition digest + first nextPollAt
  -> claim one due Subscription
  -> Plugin plans one declarative HTTP/command probe
  -> Runtime executes the bounded probe
  -> Plugin returns terminal or non-terminal observation
  -> non-terminal: advance next poll and keep active
  -> terminal: persist terminal key/observation
     + atomically activate one bound Run cycle with TriggerOccurrenceEnvelope@1
  -> duplicate terminal returns the same cycle/admission receipt
  -> source owner reconciles terminal cycle into completed/error/unknown diagnostics
```

Continuous Subscription uses a separate parent and checkpoint state machine. `ContinuousSubscriptionDefinition@2` turns each new stable occurrence key into one cycle on the same bound Run; only a succeeded cycle advances its checkpoint. V3/V1 callback definitions remain readable and executable only as persisted legacy compatibility during cutover.

## Fixed contract

Run-bound one-shot registration uses `SubscriptionDefinition@4`. The definition fixes:

- required title and exact `RunSourceBinding@1`;
- probe Plugin/config, canonical artifact revision/digest and bounded execution policy;
- interval, deadline and attempt budget;
- optional `ExternalRefTriggerBinding@1`, which fixes Project/Integration/ExternalRef revision, profile and read schema without expanding Run authority.

The Plugin fills only the `subscription.probe@1` strategy slot. It cannot register a Capability, Event type, Handler, loop or Store, and cannot directly perform ambient network, filesystem writes, process spawn or Agent invocation. The host executes declarative probes under the admitted policy.

Owner-managed `<runtime>/subscription-plugins.json` 是唯一新 plugin registry。`SubscriptionPluginRegistry@1` 把 versioned ref 映射到 canonical project/file artifact、plugin ID、适用 `until | continuous`、probe workspace 与 HTTP/executable allowlist。RunAdmissionCompiler 计算实际 artifact digest，并把所有适用 Owner entry 固定进 Run trigger authority；source registrar 再按 Steward 选择的 exact plugin ref 缩小到该 entry 的 policy。registry 缺失、字段多余、artifact/path 不可证明或 kind 不匹配都在 Event/probe 前 fail closed。

A terminal observation is durable Subscription state, not a parent Event. It includes the Plugin version, terminal outcome, optional summary and bounded facts. The one-shot Runtime owns its stable terminal key; Plugin code cannot supply cycle or admission identity. The source transaction persists terminal state and activates the bound Run cycle together, so no direct Agent, command, destination or callback Event is created.

`SubscriptionDefinition@3` 与 `ContinuousSubscriptionDefinition@1` 仍保存旧 `ProactiveCallbackDefinition@1` / exact grant，供历史运行、reconcile 与 trace 使用；V4/V2 discriminator 禁止 callbacks，并保存 Run/source/cycle/admission receipt。两条路径不能对同一 definition 双投。

## Recovery and isolation

Polling resumes from durable `nextPollAt`; cancellation, deadline expiry or attempt exhaustion stops further probes. Poll failures only update the Subscription and loop log.

带 ExternalRef binding 的 one-shot/Continuous Subscription 在每次 due probe 前重读 current Integration binding 并做最多 16 KiB 的 exact Connector read。inactive、stale、profile/placement/ownership mismatch 会把 parent 持久标成 `blocked`，不执行 probe、不 materialize callback，也不建立 Run 或外写；transport/read 异常仍走既有 poll failure/retry。相同 terminal/blocked parent 重启后不再次触发。无 binding definition 保持原行为。

Legacy callbacks run in ordinal order. A normal callback failure is terminal for that callback and does not prevent later callbacks from running. If the process stops after a callback has started but before a durable receipt is known, that callback and the remaining pending callbacks become `unknown` and are not replayed blindly. This recovery path never applies to V4/V2 Run-bound definitions.

Continuous Subscription V2 uses stable occurrence keys and a pending Run cycle receipt. A pending occurrence stops polling until the cycle is terminal; succeeded checkpoints and resumes polling, while failed/needs-human/cancelled/missing-cycle blocks without moving the prior checkpoint. A repeated occurrence key returns the existing pending cycle.

`command.exec` receives a bounded `ProactiveCallbackInput@1` JSON document on stdin. For a Continuous Subscription it includes the exact pending `PollObservation`; stdout/stderr remain in the generic callback receipt. Definition and grant require `runtime: "host"` and one exact executable, argv, cwd, environment and resource bound. The executable is trusted code: RS validates the declared entrypoint and bounds, but does not sandbox it or its transitive child processes. Persisted legacy `runtime: "node"` callbacks remain readable for history but cannot be registered or executed. RS does not parse command stdout into a business result and does not interpret the observation payload.

## Control plane

CLI and Console expose list/inspect/pause/resume/cancel diagnostics for both definition generations. Legacy definition 可以 pause/cancel，但不能 resume；Console list additionally提供 one-shot/Continuous 的统一服务端分页、搜索和 current/archived visibility；terminal archive/unarchive 不改变 lifecycle、poll checkpoint、cycle 或 legacy callback evidence。Steward `await_source` is the owner of new V4/V2 creation; `subscription add` 固定 fail closed。

Console shows definition/probe identity, terminal or pending observation, linked Run/cycle and admission receipt. V4/V2 primary navigation opens Run Workspace. Persisted callback trace remains visible under `legacy / non-public` diagnostics.

## Change guidance

- New probe kinds must define side-effect policy, secret handling, time/output bounds and cancellation semantics.
- External commands are executed once by their owner and publish a durable receipt; the Subscription probe only observes that receipt.
- New callback kinds must use the shared host callback kernel or Core admission boundary and define exact grants plus crash semantics.
- Poll attempts and observations remain Capability state; do not turn them into generic Events.
