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
Steward await_source registers SubscriptionDefinition@5
  -> validate admitted plugin ref, immutable probe artifact, policy and ProactiveTarget@1
  -> persist definition digest + first nextPollAt
  -> claim one due Subscription
  -> Plugin plans one declarative HTTP/command probe
  -> Runtime executes the bounded probe
  -> Plugin returns terminal or non-terminal observation
  -> non-terminal: advance next poll and keep active
  -> terminal: persist terminal key/observation
     + atomically activate one bound Run cycle or registered application action
  -> duplicate terminal returns the same cycle/admission or action receipt
  -> source owner reconciles terminal cycle into completed/error/unknown diagnostics
```

Continuous Subscription uses a separate parent and checkpoint state machine. `ContinuousSubscriptionDefinition@3` turns each new stable occurrence key into either one cycle on the same bound Run or one registered application action；only a succeeded cycle or succeeded/skipped action receipt advances its checkpoint。V3/V1 callback and V4/V2 Run-bound definitions remain readable as persisted compatibility。

## 原生 file event source

`ContinuousSubscriptionDefinition@4` 将 `source.kind=file` 与既有 `ProactiveTarget@1` 组合，复用 Continuous Subscription 的 status、pending observation 和成功 checkpoint；polling V1/V2/V3 保持原样。V4 不保存 probe 或 interval，`nextPollAt=null`，不通过 Plugin 注册监听，也不创建 canonical 文件 Event。

Owner 使用 `subscription register-file` 登记固定目录、递归开关、字面 suffixes、相对 exclude 路径、debounce 和最大合并延迟，以及已注册 external workflow ref。源码内 Owner action compiler 也可绑定既有 application action；Run target 必须持有既有 recurring Run binding，文件输入不自行授予 Agent 权限。目录必须是 canonical path，监听不跟随 symlink 路径；最多保留 100 个未取消的 file Subscription。

原生目录监听先于启动补齐，父目录监听负责发现根目录替换。通知只表示“指定范围需要重新读取”，不提供逐文件事件日志、文件正文或完整变更清单。`FileSourceObservation@1` 的 facts 只含 root 和 reconcile 标记；创建、删除、原子替换、无 filename 或可能影响子目录的 rename 均可引发保守补齐，因此 suffix 不是每次触发都存在匹配文件的证明。接收方自行读取当前范围并判断业务变化。停止期间已创建又消失的瞬时状态不在投影收敛保证内。

唯一 core loop 驱动现有 Continuous Subscription phase；原生通知复用 core wake，合并 deadline 纳入同一等待计算。一个 source 最多一个 pending occurrence，在途期间的新通知继续合并，旧 occurrence 成功不会清掉这些通知。每次监听重建都生成启动补齐，覆盖进程崩溃前未持久化的通知；监听错误按 1 秒退避重挂，不能静默切换为目录定时扫描。底层静默漏通知仍是原生文件监听的限制，不声称持久事件流语义。

External workflow 的 enqueue 与 pending 写入同事务，只有 succeeded 才推进 checkpoint；failed/unknown 保留 pending 并 block。继续复用 workflow 的 pre-effect retry 和 post-effect unknown 边界，不自动重放可能有副作用的命令。pause/cancel 停止新 source 准入，不撤销已经入队或执行中的 target；执行结果保留在 external workflow receipt。Runtime shutdown 先关闭监听，再执行既有 target settle。

`inspect/list` 与 Console 共用 source definition、fileListener（status、observedAt、error）、pending/checkpoint 和最近 externalWorkflowExecution。监听状态是带时间的最近观察，需结合 Runtime health 判断当前是否运行；它不构成第二份 Runtime heartbeat。日常查询不迁移数据库。

## Fixed contract

Current one-shot polling registration uses `SubscriptionDefinition@5`. The definition fixes:

- required title and exact `ProactiveTarget@1`；its Run branch contains `RunSourceBinding@1`，action branch contains versioned action ref、registration digest 与 bounded input；
- probe Plugin/config, canonical artifact revision/digest and bounded execution policy;
- interval, deadline and attempt budget;
- optional `ExternalRefTriggerBinding@1`, which fixes Project/Integration/ExternalRef revision, profile and read schema without expanding Run authority.

The Plugin fills only the `subscription.probe@1` strategy slot. It cannot register a Capability, Event type, Handler, loop or Store, and cannot directly perform ambient network, filesystem writes, process spawn or Agent invocation. The host executes declarative probes under the admitted policy.

Owner-managed `<runtime>/subscription-plugins.json` 是唯一新 plugin registry。`SubscriptionPluginRegistry@1` 把 versioned ref 映射到 canonical project/file artifact、plugin ID、适用 `until | continuous`、probe workspace 与 HTTP/executable allowlist。RunAdmissionCompiler 计算实际 artifact digest，并把所有适用 Owner entry 固定进 Run trigger authority；source registrar 再按 Steward 选择的 exact plugin ref 缩小到该 entry 的 policy。registry 缺失、字段多余、artifact/path 不可证明或 kind 不匹配都在 Event/probe 前 fail closed。

A terminal observation is durable Subscription state, not a parent Event. The source transaction persists terminal state and either activates the bound Run cycle or executes the registered application action。Action handler 只能同步写 owning SQLite transaction，不能做网络、进程、文件或 Agent 调用；异常写入回滚但 failed receipt 保留。两条 current target path 都不创建 direct callback Event。

`SubscriptionDefinition@3` 与 `ContinuousSubscriptionDefinition@1` 仍保存旧 callback/exact grant；V4/V2 保留历史 Run binding；V5/V3 只保存统一 target。三个 generation 由 discriminator 隔离，不能对同一 definition 双投。

## Recovery and isolation

Polling resumes from durable `nextPollAt`; cancellation, deadline expiry or attempt exhaustion stops further probes. Poll failures update the Subscription and loop log. For `application_action` one-shot targets, deadline or attempt exhaustion atomically records a `SubscriptionExpiry@1` failure observation and executes the action once; successful enqueue retains source status `expired`, while an action failure blocks the source. Legacy callback and Steward-bound expiry behavior is unchanged.

带 ExternalRef binding 的 one-shot/Continuous Subscription 在每次 due probe 前重读 current Integration binding 并做最多 16 KiB 的 exact Connector read。inactive、stale、profile/placement/ownership mismatch 会把 parent 持久标成 `blocked`，不执行 probe、不 materialize callback，也不建立 Run 或外写；transport/read 异常仍走既有 poll failure/retry。相同 terminal/blocked parent 重启后不再次触发。无 binding definition 保持原行为。

Legacy callbacks run in ordinal order. A normal callback failure is terminal for that callback and does not prevent later callbacks from running. If the process stops after a callback has started but before a durable receipt is known, that callback and the remaining pending callbacks become `unknown` and are not replayed blindly. This recovery path never applies to V4/V2 Run-bound definitions.

Continuous Subscription V3 uses stable occurrence keys。Run target 的 pending occurrence 等待 cycle terminal；只有 succeeded 才 checkpoint。action target 在 observation transaction 内产生 terminal receipt：succeeded/skipped 立即 checkpoint，failed 保留 pending 并 block。重复 occurrence key 返回既有 receipt，不重放 action。

`command.exec` receives a bounded `ProactiveCallbackInput@1` JSON document on stdin. For a Continuous Subscription it includes the exact pending `PollObservation`; stdout/stderr remain in the generic callback receipt. Definition and grant require `runtime: "host"` and one exact executable, argv, cwd, environment and resource bound. The executable is trusted code: RS validates the declared entrypoint and bounds, but does not sandbox it or its transitive child processes. Persisted legacy `runtime: "node"` callbacks remain readable for history but cannot be registered or executed. RS does not parse command stdout into a business result and does not interpret the observation payload.

## Control plane

CLI and Console expose list/inspect/pause/resume/cancel diagnostics，并明确区分 source、target 与 Run。Legacy definition 可以 pause/cancel，但不能 resume；terminal archive/unarchive 不改变 lifecycle、poll checkpoint、cycle、action receipt 或 legacy callback evidence。Steward `await_source` 负责 Run target 创建；Owner application 只通过 registry compiler 创建 action target；`subscription add` 固定 fail closed。

Console shows definition/probe identity、显式 target、terminal/pending observation，以及对应 Run/cycle admission receipt 或 deterministic action receipt。Persisted callback trace remains visible under `legacy / non-public` diagnostics。

## Change guidance

- New probe kinds must define side-effect policy, secret handling, time/output bounds and cancellation semantics.
- External commands are executed once by their owner and publish a durable receipt; the Subscription probe only observes that receipt.
- New callback kinds must use the shared host callback kernel or Core admission boundary and define exact grants plus crash semantics.
- Poll attempts and observations remain Capability state; do not turn them into generic Events.


File external workflow 的 failed/unknown 通过 Owner `subscription recover-file` 显式恢复，契约见 [CLI Reference](../runbook/cli-reference.md)。恢复绑定当前 blocked source、definition revision、pending execution 和 attempt；unknown 先确认实际结果，failed 只有明确确认 retry 安全后才追加一次执行预算。execution/occurrence identity 与 target 不变，原 terminal/unknown receipt 存入不可变 recovery 记录；确认成功或重试成功才推进 checkpoint。source 生命周期与 execution 恢复在同一事务提交，重复请求不重复产生副作用。

## Desktop observation delivery

统一 `run start` 在启动调用者侧进程前固定内置 completion probe 与可选 Desktop action。内部准入只接收源码拥有的 probe authority；观察已有来源时从 Owner registry 解析，调用方不能覆盖 executable authority。命令回执与崩溃边界见 [Database Reference](db-reference.md#本地长命令的文件状态)；Runtime 只检查回执，不启动或重试原命令。

The Run compiler composes a registered probe and `action:codex-desktop.push@1` through the existing application-action target. The action only enqueues Core Delivery in the source transaction; it performs no IPC and invokes no Agent. One-shot terminal observations and continuous new occurrences share the same adapter. Action receipt output is the immutable destination/body binding, and Delivery is the transport oracle; continuous checkpoint advancement means durable enqueue, not Desktop consumption. [Desktop push runbook](../runbook/codex-desktop-push.md) owns failure handling and target lifecycle limits; the CLI reference owns Run submission.

普通确定性观察和长命令通过统一 `run preflight/start` 准入，Subscription definition 由内部 compiler 装配；公共调用方不再拼装 Desktop registration JSON。预检与实际 probe 复用 `probe-validation.ts` 的工具参数、allowlist 和 workspace 检查。无回传目标使用固定 observe-only action，有目标复用 Desktop action/Delivery。详见 [统一 Run](unified-run.md)。
