---
type: Architecture
title: Rollerskate Local Scheduled Task
description: Local Runtime 内 revisioned Schedule、bounded time decision、ScheduledRun admission、Session policy 与恢复边界。
tags: [rollerskate, local, scheduled-task, schedule, cron, recovery]
timestamp: 2026-07-24
---

# Local Scheduled Task

[返回 architecture index](./index.md)

Scheduled Task 是随源码发布的第一方 Local Capability。它在本机时间条件满足时主动创建一组 host-owned callback work，不依赖 Server、操作系统 cron、Codex automation 或第二个 daemon。Schedule 自己拥有 occurrence/time policy，只与 Continuous Subscription 共用 callback contract/runtime，不共用 trigger state machine。

## Durable model

- `ScheduleDefinition` 保存稳定 ID、owner Principal、`active | paused | completed | cancelled`、current revision、下一 occurrence 与时间。
- immutable `ScheduleRevision` 保存 `once | cron` expression、timezone、misfire/overlap、grace、ordered callback definitions/exact grants，以及可选 `ExternalRefTriggerBinding@1`。binding 同时固定 Project revision、policy revision、Integration revision、ExternalRef revision、profile 与 read schema；它是触发条件，不是 effect grant。
- `ScheduledRun` 保存一个 occurrence 的 admission/skip/unknown 决定、固定 revision、coalesced window，以及关联 Event、Execution、Session 与 terminal result；callback occurrence 保存各自的 admission/receipt，二者不复制 authority。
- `(scheduleId, occurrenceKey)` 唯一。one-shot key 是 canonical UTC instant；cron key 是 `cron-v1:<timezone>:<local-date-time>`；manual key 是调用方提供的 `manual:<requestId>`。

update 必须提交 `expectedRevision`，成功后插入新 revision 并原子切换 current revision。历史 run 始终执行自己 admission 时的 immutable revision；存在未终结 run 时不能替换 Agent、workspace 或 fixed Session。

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
  -> project linked Execution terminal state
  -> admit eligible single-slot pending run
  -> claim due ScheduleDefinition
  -> bounded misfire / overlap decision
  -> unique ScheduledRun
  -> durable callback occurrence group

Proactive callback phase
  -> immediate command/destination receipt or canonical agent.request

Runtime phase
  -> AgentHandler
  -> agent.result

next Scheduled Task phase
  -> project Execution / Session into ScheduledRun
```

Scheduled Task phase 与 Subscription、Matrix、Local Chat、Runtime phase 一样由 `core/loop.ts` 串行驱动。Capability 不拥有 timer loop；loop 的 pause/stop 与顶层异常隔离仍是唯一生命周期。

带 ExternalRef binding 的 occurrence 在 callback materialize 前通过当前 Device authority 重读 active Integration binding，并让 placement Connector 做最多 16 KiB 的 exact revision read。authority/revision/profile 不匹配把该 ScheduledRun 持久标成 skipped；guard/read 不可用标成 failed。两者都不创建 callback、Run、外写或新 Event，进程重启也不会再次处理这个 terminal occurrence。无 binding 的 Schedule 完全沿用原路径。

## Session 与 workspace

- `new_each_run` admission 不带 Session；AgentHandler 为每轮创建新的 provider Session。
- `fixed` 创建或更新时必须引用同一 Agent、同一 Local workspace 的既有 `ses_`；Event 显式携带该 Session。
- 同一 schedule 或同一 fixed Session 的未终结 run 不能并发。不同 schedule 共用 fixed Session 时也会按各自 overlap policy skip 或单槽排队。
- revision workspace 必须等于 Runtime 自己的 canonical Local workspace；CLI 不接受任意 workspace 扩权。

## Crash 与 unknown

- run 已插入但 callback occurrence 尚未建立时，下一 cycle 继续 admission。
- Event 已建立但 run 尚未链接时，`source.kind=schedule` 与 `source.externalId=scheduled-run:<runId>` 返回同一个 Event/Execution receipt，不重复调用。
- queued/retrying/running/succeeded/failed Execution 持续投影到 ScheduledRun；Execution retry 不创建新 run。
- Runtime 异常退出时，已经进入 provider invocation 的 ScheduledRun 转为 `unknown`，对应 Execution 终止，不自动重放可能已有 side effect 的请求。`schedule resolve` 由人根据 provider evidence 明确标成 succeeded 或 failed，并在同一 SQLite transaction 内把该 run 剩余的 unknown/pending/started callback 写成相同 terminal outcome 与 manual-resolution receipt；已有 terminal callback 保持不变，仍有 active Core Delivery 时拒绝人工覆盖。
- `unknown` 仍视为 active work，后续 occurrence 继续服从 overlap policy。
- 任一 callback unknown 会把 ScheduledRun 投影为 unknown；terminal callback receipts 聚合为 succeeded 或 failed，command/destination-only run 不伪造 Agent Event。

## Control boundary

CLI 提供 create、update、list、inspect、pause、resume、cancel、run-now、runs、trace 与 unknown resolve。Console 提供既有 Schedule 的 list/detail、pause/resume/cancel/run-now 与 unknown reconciliation，不新增 transition：两个 entrypoint 都复用 `application/schedule/query.ts` 的 summary/detail/run view 和 `application/schedule/control.ts` 的 CAS/control policy。

query 输出当前 revision、next occurrence、run status/reason、application-computed available actions、规范化 canonical Event audit，以及每个 callback occurrence 的 phase/status/receipt/Event/Delivery identity。Console 可区分 callback 尚未 admission、已绑定 Core work、Delivery terminal 与 unknown；unknown ScheduledRun 生成稳定 Runtime Failure reference，Runtime Failure 通过 schedule ID 返回 owning Schedule view，不把 run history 复制进 Runtime projection。

远端 Server 不参与创建。未来 Server command 只能请求 Local admission，不能绕过本 repository、revision、workspace、Session 或 time policy。
