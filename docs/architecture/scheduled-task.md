---
type: Architecture
title: Rollerskate Local Scheduled Task
description: Local Runtime 内 revisioned Schedule、bounded time decision、ScheduleOccurrence admission、Steward Run binding 与恢复边界。
tags: [rollerskate, local, scheduled-task, schedule, cron, recovery]
timestamp: 2026-07-24
---

# Local Scheduled Task

[返回 architecture index](./index.md)

Scheduled Task 是随源码发布的第一方 Local Capability。它在本机时间条件满足时推进一个 durable occurrence，不依赖 Server、操作系统 cron、Codex automation 或第二个 daemon。Schedule 自己拥有 time、misfire、overlap、freshness 与 source lifecycle policy；`ScheduleRevision@2` 只通过已准入的 Steward Run 激活 cycle。历史 `ScheduleRevision@1` 仍走 callback 兼容路径，不能反向成为新 Run authority。

## Durable model

- `ScheduleDefinition` 保存稳定 ID、owner Principal、`active | paused | completed | cancelled`、current revision、下一 occurrence 与时间。
- immutable `ScheduleRevision@2` 保存 `once | cron` expression、timezone、misfire/overlap、grace、`RunSourceBinding@1`，以及可选 `ExternalRefTriggerBinding@1`。它不保存 Agent、prompt、workspace、Session policy 或 callback；这些 authority 已由 Run admission 固定。
- `ScheduleOccurrence` 保存一个 occurrence 的 admission/skip/unknown 决定、固定 revision 与 coalesced window。V2 occurrence 关联 `agentRunId`、`cycleId` 和严格 `ScheduleOccurrenceAdmissionReceipt@1`，不关联自己的 Agent Event/Execution/Session；V1 兼容 occurrence 仍可关联旧 Event/Execution/Session/callback receipt。
- `(scheduleId, occurrenceKey)` 唯一。one-shot key 是 canonical UTC instant；cron key 是 `cron-v1:<timezone>:<local-date-time>`；manual key 是调用方提供的 `manual:<requestId>`。

V2 Schedule 只能由 Steward `RunDecision@3(action=await_source)` 的 exact `schedule.once@1 | schedule.cron@1` template 创建，并与 Run source binding 在同一个 SQLite transaction 内提交。公共 `schedule create/update` 已关闭 legacy write；V1 只能 readback、pause/cancel、archive 与 resolve unknown，不能 resume 或 run-now。历史 occurrence 始终按自己 admission 时的 immutable snapshot 恢复。

## Time contract

- `once-rfc3339-v1` 只接受带 `Z` 或明确 offset 的 RFC 3339 instant，持久化为 UTC。
- `cron-v1` 固定五字段 `minute hour day-of-month month day-of-week`，支持数字、`*`、列表、闭区间与 `/step`；不支持 seconds、名称、macro 或 `L/W/#/?`。day-of-month 与 day-of-week 同时受限时使用传统 cron OR。
- cron 必须保存 IANA timezone。重复小时只选择较早 offset 对应的 instant；缺失小时形成显式 missing occurrence，再经过 misfire policy。
- grace 内是普通 due；超过 grace 后 `skip` 记录一个 bounded skipped run，`run_once` 把 missed window 合并成一轮。不会逐条无界 backfill。
- overlap `skip` 记录 bounded skip；`queue` 最多保留一个没有 Event 的 pending run，后续 occurrence 只推进 `coalescedThrough`。
- `run-now` 使用独立 manual key，不移动正常 `nextRunAt`，并继续服从 overlap policy。

## Core-loop workflow

```text
Scheduled Task phase
  -> project linked Run cycle or legacy Execution terminal state
  -> admit eligible single-slot pending occurrence
  -> claim due ScheduleDefinition
  -> bounded misfire / overlap decision
  -> unique ScheduleOccurrence
  -> V2: atomically activate bound Steward Run cycle
     or V1: durable callback occurrence group

Proactive callback phase
  -> immediate command/destination receipt or canonical agent.request

Runtime phase
  -> AgentHandler
  -> agent.result

next Scheduled Task phase
  -> project cycle or legacy Execution into ScheduleOccurrence
```

Scheduled Task phase 与 Subscription、Matrix、Local Chat、Runtime phase 一样由 `core/loop.ts` 串行驱动。Capability 不拥有 timer loop；loop 的 pause/stop 与顶层异常隔离仍是唯一生命周期。

带 ExternalRef binding 的 occurrence 在任何 callback materialize 或 Run cycle activation 前，通过当前 Device authority 重读 active Integration binding，并让 placement Connector 做最多 16 KiB 的 exact revision read。authority/revision/profile 不匹配把该 ScheduleOccurrence 持久标成 skipped；guard/read 不可用标成 failed。两者都不创建 callback、cycle、外写或新 Event，进程重启也不会再次处理这个 terminal occurrence。

V2 admission 在一个 `BEGIN IMMEDIATE` transaction 内写 ScheduleOccurrence、`TriggerOccurrenceEnvelope@1`、Run cycle、orchestrator Event/Execution 与 admission receipt。重复 due、相同 run-now request、restart 或并发 claim 都只能得到原 occurrence/cycle。cycle terminal 后 occurrence 投影为 terminal，Run 回到 `awaiting_source`；Run terminal/cancel 则按 source binding 的 `pause_source | cancel_source` 收口 Schedule 和所有 queued occurrence。

## Legacy Session 与 workspace

- `new_each_run` admission 不带 Session；AgentHandler 为每轮创建新的 provider Session。
- `fixed` 创建或更新时必须引用同一 Agent、同一 Local workspace 的既有 `ses_`；Event 显式携带该 Session。
- 同一 schedule 或同一 fixed Session 的未终结 run 不能并发。不同 schedule 共用 fixed Session 时也会按各自 overlap policy skip 或单槽排队。
- revision workspace 必须等于 Runtime 自己的 canonical Local workspace；CLI 不接受任意 workspace 扩权。

## Crash 与 unknown

- V1 occurrence 已插入但 callback occurrence 尚未建立时，下一 cycle 继续 admission。
- Event 已建立但 run 尚未链接时，`source.kind=schedule` 与 `source.externalId=scheduled-run:<runId>` 返回同一个 Event/Execution receipt，不重复调用。
- V1 queued/retrying/running/succeeded/failed Execution 持续投影到 ScheduleOccurrence；Execution retry 不创建新 occurrence。V2 从 durable Run cycle 恢复，不根据 wall clock 或 transcript 重建 envelope/cycle。
- Runtime 异常退出时，已经进入 provider invocation 的 V1 ScheduleOccurrence 转为 `unknown`，对应 Execution 终止，不自动重放可能已有 side effect 的请求。`schedule resolve` 只允许处理这种 legacy unknown；Run-bound occurrence 必须从 Run/cycle authority reconciliation，不能人工改写结果。
- `unknown` 仍视为 active work，后续 occurrence 继续服从 overlap policy。
- 任一 callback unknown 会把 V1 ScheduleOccurrence 投影为 unknown；terminal callback receipts 聚合为 succeeded 或 failed，command/destination-only occurrence 不伪造 Agent Event。

## Control boundary

CLI 提供 list、inspect、pause、resume、cancel、run-now、occurrences、trace 与 legacy unknown resolve；create/update 固定 fail closed，legacy resume/run-now 同样拒绝。`schedule runs` 暂为 `occurrences` 的兼容 alias。Console 的 `/occurrences` 是主读取路径，`/runs` 保留兼容。两个 entrypoint 复用 `application/schedule/query.ts` 的 summary/detail/occurrence view 和 `application/schedule/control.ts` 的 control policy。

query 输出当前 revision、next occurrence、occurrence status/reason、application-computed available actions和规范化 audit。V2 diagnostics 直接给出 bound Run、cycle 与 exact admission receipt，并提供 Steward Run deep link；V1 继续显示 Event/Execution/Session/callback。unknown legacy occurrence 生成稳定 Runtime Failure reference，Runtime Failure 通过 schedule ID 返回 owning Schedule view，不复制 occurrence history。

远端 Server 不参与创建。未来 Server command 只能请求 Local admission，不能绕过本 repository、revision、workspace、Session 或 time policy。
