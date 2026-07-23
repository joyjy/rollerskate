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

- canonical Event：统一 ID、type/source、Agent、Session/Destination 引用与 causality；输入 Event 携带 prompt，`agent.result` 携带 outcome/output/error。
- Execution：唯一 Event、唯一 Handler、attempt/max attempts、next retry、terminal status。
- Session：Agent、adapter、workspace 与 provider session ID。
- Destination/Delivery：显式外部目标、稳定 delivery ID、attempt、retry 与 receipt。
- Poll Subscription：Plugin/config/policy、interval/deadline/max attempts、next poll、固定 callback Session/prompt 与唯一 fire Event ID。
- Device/Agent identity 与本地 credential/config。
- Matrix binding：Destination、Room、Agent、当前 Session 与 read-through cursor。

旧 Work、lease、generic outbox、RoomChat invocation/turn/outbox 与独立 continuation work 不再是当前 Runtime domain。

## Reliability invariants

- Event 入库与唯一 queued Execution 原子完成。
- 同一 `(source.kind, source.externalId)` 只接受一次；Server Event 直接以全局 Event ID 去重。
- 每个 Event type 只有一个 Handler，不 fanout。
- Agent Execution 使用有限指数退火；达到 max attempts 后产生一个 failed `agent.result` Event。
- `agent.result` 只由 ResultHandler Execution 处理；Delivery retry 不重跑 Handler，ResultHandler terminal failure 不递归创建 Event。
- Matrix Delivery 使用稳定 delivery ID 作为 transaction ID。
- terminal Subscription 与 `subscription.fire` Event/Execution 原子建立；非 terminal poll 不创建 Event。
- 已成功或最终失败的 Execution 不因重启重放。

## Crash and shutdown

Local Runtime loop 串行推进 Subscription、Matrix ingress 与 Runtime cycle，但每个 cycle 和每条 Execution/Delivery 分别隔离异常。单个失败只写结构化 failure log，不能结束主进程。

启动恢复把中断的 `running` Execution 与 `delivering` Delivery 放回 `retry_wait`；Subscription 恢复中断 poll 并遵守剩余 deadline/attempt。SIGINT/SIGTERM 停止接收新 cycle，并通过 AbortSignal 取消可取消的 probe。

如果 provider side effect 无法安全重试，adapter 必须在形成通用能力前引入明确 unknown/receipt 契约；v0.3 不声称 exactly-once provider side effect。

## Schema cutover

schema v31 只维护当前统一核心与 Device/Agent/Subscription facts，不再包含 `results` 表。检测到旧 Work `deliveries`、中间 Route schema 或独立 Result schema 时，Runtime 清理不兼容的执行事实表并重建统一表；Device/Agent identity 保留。v0.3 没有真实用户，不提供 legacy production data migration。

## Change guidance

- 新副作用必须定义 stable ID、terminal receipt、retry ownership 与是否允许自动重试。
- 修改 Event/Execution/Delivery 状态机必须覆盖 duplicate、restart、failure isolation 与 terminal no-replay。
- 新 durable facts 必须出现在 Console audit 或明确说明为何仅是内部调度状态。
