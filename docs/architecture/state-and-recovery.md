---
type: Architecture
title: Rollerskate State And Recovery
description: Local Runtime 的统一 durable facts、有限重试、异常隔离与恢复边界。
tags: [rollerskate, sqlite, recovery, event, reliability]
timestamp: 2026-07-23
---

# State And Recovery

[返回 architecture index](./index.md)

Local Runtime 使用 Node 内置 SQLite 与 WAL。SQLite 是本机执行事实源；结构化日志提供运行审计，但不替代 durable facts。

## Durable domains

- canonical Event：统一 ID、type/source、Agent、Session/Destination snapshot 与 causality；输入 Event 携带 prompt，`agent.result` 携带 outcome/output/error。
- Local foundation：generated LocalDevice、唯一 LocalWorkspace/Local Chat、Local Topic、嵌入的 Owner identity 与创建时间。
- LocalAgent：短 handle、active/suspended、client、execution config 与 current Session pointer。
- Local Chat：immutable `chat.message`/`chat.dispatch`、Execution 上的 versioned attention/decision receipt、Topic/Global presence、prompt resource ID 与 handle snapshot。
- Execution：唯一 Event、唯一 Handler、attempt/max attempts、next retry、terminal status和 bounded versioned receipt。
- Session：Agent、adapter、workspace 与 provider Session ID。
- Delivery：稳定 delivery ID、immutable Destination kind/address snapshot、attempt、retry 与外部 receipt；当前 kind 为 Matrix 或 macOS notification。
- Poll Subscription：title、owner Agent、Plugin/config/policy、interval/deadline/max attempts、next poll、固定 provider Session/adapter/workspace/prompt snapshot、terminal 时 lazy materialize 的本地 Session、唯一 fire Event ID 与 notification Destination。
- Local Scheduled Task：Schedule current definition/revision/next occurrence，以及按 occurrence 唯一、固定 immutable definition snapshot、可关联 Event/Execution/Session/result 的 ScheduledRun。
- Review：bounded aggregate 保存 current phase、两个 role Session 与 transition receipts。
- Notice：derived projection 与 authoritative read/ack 同表；rebuild 只覆盖 derived columns。
- Server connection/binding 不属于当前 Local schema；v0.4 按真实远端 identity/authentication 生命周期重新建立。
- Matrix outbound 可以消费已经 admission 的 Destination snapshot；Matrix ingress binding/cursor/Session persistence 等 v0.4 按 Server Topic/TransportBinding 生命周期重建。

旧 Work、lease、generic outbox、RoomChat invocation/turn/outbox 与独立 continuation work 不再是当前 Runtime domain。

## Reliability invariants

- Event 入库与唯一 queued Execution 原子完成。
- 同一 `(source.kind, source.externalId)` 只接受一次；Server Event 直接以全局 Event ID 去重。
- 同一 source message 对同一 Agent 只能有一个 attention receipt 和最多一个 `chat.dispatch`；ChatHandler 重试不会重复 admission。
- Global snooze 优先于 Topic presence；直接 mention、对应 scope 的 literal wake keyword 或到期让 Agent获得一次重新决策机会，最终 presence 仍以本轮 `ChatDecision@1` 为准。
- 每个 Event type 只有一个 Handler，不 fanout。
- Agent Execution 使用有限指数退火；传统 input 达到 max attempts 后产生一个 failed `agent.result` Event，`chat.dispatch` failure 不产生 relay。
- `agent.result` 只由 ResultHandler Execution 处理；Delivery retry 不重跑 Handler，ResultHandler terminal failure 不递归创建 Event。
- Matrix Delivery 使用稳定 delivery ID 作为 transaction ID。
- terminal Subscription 与 `subscription.fire` Event/Execution 原子建立；非 terminal poll 不创建 Event。
- terminal callback 的 macOS notification Delivery 最多尝试一次；Delivery failure 不修改 callback outcome。
- 已成功或最终失败的 Execution 不因重启重放。
- ScheduledRun 的 `(scheduleId, occurrenceKey)` 唯一；Event admission 以 `scheduled-run:<runId>` 再次去重。misfire 只记录一个 bounded skip/run-once window，overlap queue 只有一个 pending slot。
- Scheduled Task 固定 Session 与同 schedule work 串行；manual run 使用调用方 request ID，并且不移动正常 occurrence。

## Crash and shutdown

Local Runtime loop 串行推进 Subscription、Local Chat、Scheduled Task 与 Runtime cycle，但每个 cycle 和每条 Execution/Delivery 分别隔离异常。单个失败只写结构化 failure log，不能结束主进程。Matrix ingress 在 v0.4 binding model 完成前不进入当前 loop。

启动恢复把普通中断的 `running` Execution 与 retryable `delivering` Delivery 放回有限重试；Subscription 恢复中断 poll 并遵守剩余 deadline/attempt。ScheduledRun 已经进入 provider invocation 时，run 转为 `unknown`，对应 Execution 终止，直到用户根据 provider evidence 使用 CLI resolve；不会自动重放可能已有 side effect 的请求。SIGINT/SIGTERM 停止接收新 cycle，并通过 AbortSignal 取消可取消的 probe。

Scheduled Task 声称 exactly-once 的边界是本地 occurrence/Event/Execution admission，不是 provider side effect。provider outcome 无法确认时保持 `unknown`；其他 capability 若要改变默认 Runtime retry，也必须先定义自己的 unknown/receipt/reconciliation 契约。

## Schema cutover

schema v43 把 v42 的 29 张业务表收敛为 13 张物理表：`schema_meta`、`local_foundation`、`agents`、`agent_sessions`、`events`、`executions`、`deliveries`、`chat_presence`、`subscriptions`、`schedules`、`scheduled_runs`、`reviews`、`notices`。v42 → v43 migration 在单一 transaction 内保存 canonical facts、retry state、Session continuity、Capability current state/已发生 snapshot、Review transition 和 Notice read/ack，并删除没有当前产品生命周期的 legacy Chat、enrollment 与 Server binding 表。完整 authority 和映射见 [Database Reference](./db-reference.md)。默认 Runtime 完全忽略旧 repo-local `.rollerskate/`，不迁移也不删除；只有用户显式选择某个 runtime 时才执行其 schema migration。

## Change guidance

- 新副作用必须定义 stable ID、terminal receipt、retry ownership 与是否允许自动重试。
- 修改 Event/Execution/Delivery 状态机必须覆盖 duplicate、restart、failure isolation 与 terminal no-replay。
- 新 durable facts 必须出现在 Console audit 或明确说明为何仅是内部调度状态。
