---
type: Architecture
title: Rollerskate Local Scheduled Task
description: Local Runtime 内 revisioned Schedule、bounded time decision、ScheduleOccurrence admission、Steward Run binding 与恢复边界。
tags: [rollerskate, local, scheduled-task, schedule, cron, recovery]
timestamp: 2026-07-24
---

# Local Scheduled Task

[返回 architecture index](./index.md)

Scheduled Task 是随源码发布的第一方 Local Capability。它在本机时间条件满足时推进一个 durable occurrence，不依赖 Server、操作系统 cron、Codex automation 或第二个 daemon。Schedule 自己拥有 time、misfire、overlap、freshness 与 source lifecycle policy；`ScheduleRevision@3` 通过 `ProactiveTarget@1` 选择已准入 Steward Run、Owner-registered deterministic application action 或 Owner-registered external workflow。历史 V1 callback 与 V2 Run-bound definition 只保留兼容读取和恢复。

## Durable model

- `ScheduleDefinition` 保存稳定 ID、owner Principal、`active | paused | completed | cancelled`、current revision、下一 occurrence 与时间。
- immutable `ScheduleRevision@3` 保存 `once | cron` expression、timezone、misfire/overlap、grace、统一 target，以及可选 `ExternalRefTriggerBinding@1`。Steward Run target 内嵌 exact `RunSourceBinding@1`；application action target 固定 versioned action ref、registration digest 与 bounded input；external workflow target 固定 versioned workflow ref、Owner registration digest、bounded input 与 retry policy。三种 target 都不保存 raw Agent、prompt、workspace、Session policy、callback、executable、argv 或 grant。
- `ScheduleOccurrence` 保存一个 occurrence 的 admission/skip/unknown 决定、固定 revision 与 coalesced window。Run target occurrence 关联 `agentRunId`、`cycleId` 和严格 admission receipt；action target occurrence 关联共享 immutable action receipt；external workflow occurrence 关联 deterministic execution ID 与独立 terminal/unknown receipt。后两者都不关联 Agent Event/Execution/Session。V1/V2 occurrence 按原 contract 恢复。
- `(scheduleId, occurrenceKey)` 唯一。one-shot key 是 canonical UTC instant；cron key 是 `cron-v1:<timezone>:<local-date-time>`；manual key 是调用方提供的 `manual:<requestId>`。

Steward Run target 只能由 `RunDecision@3(action=await_source)` 的 exact `schedule.once@1 | schedule.cron@1` template 创建，并与 Run source binding 在同一个 SQLite transaction 内提交。application action target 只能由 `OwnerProactiveSourceCompiler` 通过固定 registry entry 编译；external workflow target 只能从 runtime mode-0600 `external-workflows.json` 中的 exact versioned registration 编译。调用方只提交 workflow ref 与幂等 migration request，不能提交 raw callback、executable、argv、environment 或 grant。公共 `schedule create/update` 已关闭 legacy write；V1 只能 readback、pause/cancel、archive 与 resolve unknown，不能直接 resume 或 run-now，迁移为 V3 后才恢复 current control。历史 occurrence 始终按自己 admission 时的 immutable snapshot 恢复。

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
  -> V3 target:
       Steward Run -> atomically activate bound cycle
       application action -> synchronously execute in source transaction + terminal receipt
       external workflow -> enqueue deterministic execution
     or V1/V2 compatibility path

External workflow phase
  -> renew one active lease or claim one due execution
  -> registry/digest preflight
  -> persist effect boundary
  -> bounded no-shell host command + terminal/unknown receipt

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

Steward Run admission 在一个 `BEGIN IMMEDIATE` transaction 内写 ScheduleOccurrence、`TriggerOccurrenceEnvelope@1`、Run cycle、orchestrator Event/Execution 与 admission receipt。application action 在同一 source transaction 内通过 SQLite SAVEPOINT 隔离 handler mutation：成功或 skipped 提交 mutation 与 terminal receipt，异常回滚 handler mutation后仍提交 failed receipt 和 terminal occurrence。external workflow 在同一 source transaction 内写 deterministic execution，随后由唯一 loop 的 `proactive.external-workflow` phase 异步推进；Owner registry 固定 executable digest、argv、cwd、exact environment、filesystem roots、network declaration、timeout/output bound 与 retry policy。Runtime 使用 `execFile` 而非 shell，并在 spawn 前持久化 effect boundary。重复 due、相同 run-now request、restart 或并发 claim 都只能回到原 occurrence/execution/receipt。

## Legacy Session 与 workspace

- `new_each_run` admission 不带 Session；AgentHandler 为每轮创建新的 provider Session。
- `fixed` 创建或更新时必须引用同一 Agent、同一 Local workspace 的既有 `ses_`；Event 显式携带该 Session。
- 同一 schedule 或同一 fixed Session 的未终结 run 不能并发。不同 schedule 共用 fixed Session 时也会按各自 overlap policy skip 或单槽排队。
- revision workspace 必须等于 Runtime 自己的 canonical Local workspace；CLI 不接受任意 workspace 扩权。

## Crash 与 unknown

- V1 occurrence 已插入但 callback occurrence 尚未建立时，下一 cycle 继续 admission。
- Event 已建立但 run 尚未链接时，`source.kind=schedule` 与 `source.externalId=scheduled-run:<runId>` 返回同一个 Event/Execution receipt，不重复调用。
- V1 queued/retrying/running/succeeded/failed Execution 持续投影到 ScheduleOccurrence；Execution retry 不创建新 occurrence。Run target 从 durable cycle 恢复；action target 从 deterministic receipt 恢复；external workflow 从独立 execution/lease/receipt 恢复，三者都不根据 wall clock 或 transcript 重建 effect。
- external workflow 在 effect boundary 前中断时清除 lease 并按冻结的 attempt budget 重试；达到 budget 后 failed。boundary 后中断、timeout、abort 或无法证明 child exit code 时写 `unknown`，不自动 replay。Owner 用 `schedule resolve` 结合外部 LWW/receipt 明确裁决，原 unknown receipt 继续保留。
- Runtime 异常退出时，已经进入 provider invocation 的 V1 ScheduleOccurrence 转为 `unknown`，对应 Execution 终止，不自动重放可能已有 side effect 的请求。`schedule resolve` 只允许处理这种 legacy unknown；Run-bound occurrence 必须从 Run/cycle authority reconciliation，不能人工改写结果。
- `unknown` 仍视为 active work，后续 occurrence 继续服从 overlap policy。
- 任一 callback unknown 会把 V1 ScheduleOccurrence 投影为 unknown；terminal callback receipts 聚合为 succeeded 或 failed，command/destination-only occurrence 不伪造 Agent Event。

## Control boundary

CLI 提供 list、inspect、pause、resume、cancel、run-now、`migrate-workflow`、occurrences、trace 与 unknown resolve；create/update 固定 fail closed，未迁移 V1 的 resume/run-now 仍拒绝。`migrate-workflow` 要求 paused V1、expected revision、Owner registry ref 与稳定 request ID，并在同一 transaction 中保存 immutable old→new migration receipt。`schedule runs` 暂为 `occurrences` 的兼容 alias。Console 的 `/occurrences` 是主读取路径，`/runs` 保留兼容。两个 entrypoint 复用 `application/schedule/query.ts` 的 summary/detail/occurrence view 和 `application/schedule/control.ts` 的 control policy。

query 输出当前 revision、next occurrence、显式 source/target、occurrence status/reason、application-computed available actions和规范化 audit。Run target diagnostics 给出 bound Run、cycle 与 exact admission receipt；action target diagnostics 给出 action ref 和 terminal receipt；external workflow diagnostics 给出 execution state、attempt/lease/effect boundary、runtime receipt 与 manual resolution。V1 继续显示 Event/Execution/Session/callback。

远端 Server 不参与创建。未来 Server command 只能请求 Local admission，不能绕过本 repository、revision、workspace、Session 或 time policy。
