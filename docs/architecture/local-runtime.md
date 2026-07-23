---
type: Architecture
title: Rollerskate Local Runtime
description: Offline-first Local Runtime 的 canonical Event、单 Handler Route、Session 与审计边界。
tags: [rollerskate, local-runtime, event, handler, audit]
timestamp: 2026-07-23
---

# Local Runtime

[返回 architecture index](./index.md)

一个设备只运行一个 Local Runtime loop。CLI、Subscription、Matrix 与未来 Server ingress 都先构造同一种 canonical Event，持久化后才由 loop 处理。

```text
CLI request ─────────┐
Subscription fire ──┼─> canonical Event + Execution ─> Event.type ─> exactly one Handler
Matrix projection ──┤                                      │
Server Event ────────┘                                      v
                                               agent.result Event
                                                          │
                                                          v
                                                ResultHandler Execution
                                                          │
                                                          v
                                              zero or more Deliveries
```

## Canonical Event

`local/src/core/event/model.ts` 是 Event source of truth。所有 Event 都包含全局 `evt_` UUIDv7、固定 `type`、source、Agent、可选 Session/Destination，以及 `rootEventId/parentEventId/hop` 因果关系。输入 Event 携带 prompt；`agent.result` 携带 outcome 与 bounded output/error。

- CLI 与 Subscription 在本地构造 Event 并生成统一 ID。
- Matrix projection 构造新的 Rollerskate Event，并以 Matrix event ID 作为外部幂等键。
- v0.4 Server ingress 必须原样保存 Server 已生成的 Rollerskate Event ID，不能建立第二个语义副本。
- 用户入口不接受任意 Event envelope；每种 ingress 只接受自己的固定 schema。

`RuntimeStore.appendEvent` 原子保存 Event 与唯一 Execution。旧 `inputs → TriggerRouter → Work[]`、generic emit 和独立 Event store 已移除。

源码中的 core 位于 `local/src/core/`，其中 `core/loop.ts` 拥有唯一长期运行的 loop、cycle 调度、pause/stop 生命周期和顶层异常隔离。`bootstrap/runtime.ts` 只创建固定的 application service、第一方 Capability 与 integration，再交给 core loop 驱动；它不拥有第二个 loop，也不允许 Capability 启动自己的 daemon。完整 ownership 见 [Source map](./source-map.md)。

## Route 与 Handler

Route 只表示 `Event.type → Handler kind`。每个 Event type 恰好对应一个 Handler，不支持 fanout，也没有 Observer 扩展点。`agent.request` 与 `subscription.fire` 路由到 `AgentHandler`；`agent.result` 路由到 `ResultHandler`。

`AgentHandler` 调用由 Agent identity 选择的 provider adapter，并由 Execution 持久化有限指数退火重试。成功或最终失败都原子创建一个 `agent.result` Event 及其 ResultHandler Execution。ResultHandler 不调用 Agent；如需二次加工，必须创建新的 causal Event。

Matrix Room 不是本地 Route。它是 ingress binding 和可选 Destination：Matrix 消息先转换成输入 Event，`agent.result` 之后才按 Destination 建立 Delivery。

## Capability 与 Plugin

Subscription 是第一方 bundled Capability：它随 Rollerskate 源码、migration、测试和发布交付，由项目负责运行稳定性。Capability 可以通过固定 ingress 产生预先注册的 Event，但不能绕过 core 或建立并列 loop。

用户 Plugin 不是 Capability，也不是 Handler。它只能实现 Capability 预先声明的受限 strategy slot；当前唯一 slot 是 `subscription.probe@1`。Plugin 不能注册 Event type、Route、Handler、loop 或 store，不能直接调用 Agent 或访问 Runtime。完整信任边界见 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。

## Session、恢复与异常隔离

Session 保存本地 Session ID、Agent、adapter、workspace 与 provider session ID。显式续接必须同时匹配这些字段。Loop 统一推进 due Execution，再推进 Delivery；AgentHandler 与 ResultHandler 都通过同一种 Execution 生命周期运行。单个 handler、Subscription 或 Matrix cycle 失败不能结束主进程。

中断恢复只把 `running` Execution 与 `delivering` Delivery 放回有限重试状态。已经 terminal 的 Agent Execution 不重放 provider 调用。

## 审计

SQLite 是本机持久事实源。Console 只读展示 input Event → AgentHandler Execution → `agent.result` Event → ResultHandler Execution → Session/Delivery/Destination；不提供 Event 写 API。`rs trace <event-id>` 读取同一审计链。

Loop 输出结构化 JSON log，包括 Subscription、Matrix ingress、Runtime cycle 与 cycle failure。v0.3 先用这些日志做运行审计，不引入 Observer；需要 durable 的产品事实仍必须进入统一数据库。

## Process boundary

Agent adapter 使用 absolute executable、args array、`shell:false`、显式 cwd/environment、structured stdin/stdout、timeout 与输出上限。Codex adapter 首次执行创建 provider Session，后续通过本地 Session 精确恢复。

Poll Plugin 只能计划和解析一次受限 probe；真实 HTTP/command 由 Runtime 按 allowlist、workspace、environment、timeout 与 output budget 执行。非 terminal poll 只更新 Subscription 状态和 debug log，只有 terminal `subscription.fire` 才成为 Event。

## Change guidance

- 新 ingress 必须先定义固定输入 schema，再转换为 canonical Event。
- 新 Event type 必须在 Route 中指定唯一 Handler，并有无 fanout 测试。
- 新 Capability 必须修改源码并进入正式 migration、verification 与 release；不通过 Plugin 动态安装。
- 新 Plugin slot 必须声明 host-owned side effects、权限、资源预算、版本、审计与失败语义。
- 新外部输出目标实现 Destination adapter，不进入 Route。
- 需要二次处理时创建带因果关系的新 Event。
- Server Event 接入属于 v0.4；v0.3 不修改 Server 路由实现。
