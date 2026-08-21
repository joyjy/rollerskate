---
type: Architecture
title: Subscription
description: one-shot terminal callback 与 Continuous Subscription delta/checkpoint 的独立生命周期。
tags: [rollerskate, subscription, polling, callback]
timestamp: 2026-07-30
---

# Subscription

[返回 architecture index](./index.md)

## 主路径

```text
register SubscriptionDefinition@3
  -> validate active owner, immutable probe artifact, policy and ordered exact-grant callbacks
  -> persist definition digest + first nextPollAt
  -> claim one due Subscription
  -> Plugin plans one declarative HTTP/command probe
  -> Runtime executes the bounded probe
  -> Plugin returns terminal or non-terminal observation
  -> non-terminal: advance next poll and keep active
  -> terminal: persist terminal key/observation and open callback phase
  -> shared ProactiveCallbackRuntime executes callbacks in ordinal order
     -> command.exec: execute through the host callback kernel
     -> destination.deliver: admit one host-origin Core Delivery
     -> agent.invoke: admit one subscription.fire Event using callback identity and exact authority
  -> reconcile callback receipts into completed/blocked/error/unknown parent state
```

Continuous Subscription uses a separate parent and checkpoint state machine. A new stable occurrence key materializes a shared proactive callback group; only terminal callback receipts advance its checkpoint.

## Fixed contract

One-shot registration accepts only `SubscriptionDefinition@3` (`schemaVersion: 3`). The definition fixes:

- required title and active owner Agent;
- probe Plugin/config, canonical artifact revision/digest and bounded execution policy;
- interval, deadline and attempt budget;
- at most 16 ordered callbacks, each with an immutable definition and exact grant;
- `approvedGrantDigest`, which must match the callback grants.
- 可选 `ExternalRefTriggerBinding@1`，固定 Project/Integration/ExternalRef revision、profile 与 read schema，但不扩大 probe/callback grant。

The Plugin fills only the `subscription.probe@1` strategy slot. It cannot register a Capability, Event type, Handler, loop or Store, and cannot directly perform ambient network, filesystem writes, process spawn or Agent invocation. The host executes declarative probes under the admitted policy.

A terminal observation is durable Subscription state, not a parent Event. It includes the Plugin version, terminal outcome, optional summary and bounded facts. The one-shot Runtime owns its stable terminal key; Plugin code cannot supply callback identity. Only an `agent.invoke` callback enters the canonical Event pipeline as `subscription.fire`; its `source.externalId` uses the durable callback occurrence ID, so each trigger occurrence admission is independently idempotent.

One-shot、Continuous Subscription 与 Schedule 使用同一 `ProactiveCallbackDefinition@1` / `ProactiveCallbackGrant@1` contract，只支持 `command.exec | agent.invoke | destination.deliver`。`agent.invoke` 的 exact grant 固定 Agent、workspace、workspace access 与 network access；one-shot adapter 在 Event admission 时补入 terminal observation、workspace revision 和 `SubscriptionAgentResult@1` result contract。Schedule reconciliation 只处理 `schedule` owner，不能先于 Subscription adapter 按 provider 退出码收敛其他 owner；Console 分别投影 invocation status 和结构化 business result，因此 `blocked` / `failed` 不会显示为成功。

## Recovery and isolation

Polling resumes from durable `nextPollAt`; cancellation, deadline expiry or attempt exhaustion stops further probes. Poll failures only update the Subscription and loop log.

带 ExternalRef binding 的 one-shot/Continuous Subscription 在每次 due probe 前重读 current Integration binding 并做最多 16 KiB 的 exact Connector read。inactive、stale、profile/placement/ownership mismatch 会把 parent 持久标成 `blocked`，不执行 probe、不 materialize callback，也不建立 Run 或外写；transport/read 异常仍走既有 poll failure/retry。相同 terminal/blocked parent 重启后不再次触发。无 binding definition 保持原行为。

Callbacks run in ordinal order. A normal callback failure is terminal for that callback and does not prevent later callbacks from running. If the process stops after a callback has started but before a durable receipt is known, that callback and the remaining pending callbacks become `unknown` and are not replayed blindly. Agent Event/Execution work already admitted to Core follows Core recovery and is reconciled back into the callback occurrence.

Continuous Subscription uses `ContinuousSubscriptionDefinition@1`, stable occurrence keys and shared proactive callback definitions/occurrences. A pending occurrence stops polling until all callbacks are terminal; then the occurrence is checkpointed and polling continues. A repeated occurrence key is a no-op.

`command.exec` receives a bounded `ProactiveCallbackInput@1` JSON document on stdin. For a Continuous Subscription it includes the exact pending `PollObservation`; stdout/stderr remain in the generic callback receipt. Definition and grant require `runtime: "host"` and one exact executable, argv, cwd, environment and resource bound. The executable is trusted code: RS validates the declared entrypoint and bounds, but does not sandbox it or its transitive child processes. Persisted legacy `runtime: "node"` callbacks remain readable for history but cannot be registered or executed. RS does not parse command stdout into a business result and does not interpret the observation payload.

## Control plane

CLI and Console expose the same add/list/inspect/pause/resume/cancel lifecycle. List and inspect return only current one-shot and Continuous views; no v2/legacy shape remains.

Console shows definition/probe identity, terminal observation, callback definitions, exact grants and receipts. For one-shot Agent callbacks it shows Core Runtime invocation status separately from parsed `SubscriptionAgentResult@1` status. Agent callback Event/Execution audit remains owned by Core Runtime and is referenced by the callback occurrence rather than by a parent `fireEventId`.

## Change guidance

- New probe kinds must define side-effect policy, secret handling, time/output bounds and cancellation semantics.
- External commands are executed once by their owner and publish a durable receipt; the Subscription probe only observes that receipt.
- New callback kinds must use the shared host callback kernel or Core admission boundary and define exact grants plus crash semantics.
- Poll attempts and observations remain Capability state; do not turn them into generic Events.
