---
type: Architecture
title: Rollerskate Local Runtime
description: Local-first Runtime 的默认基础设施、canonical Event、immutable Local Chat、单 Handler Route、Session 与审计边界。
tags: [rollerskate, local-runtime, event, handler, audit]
timestamp: 2026-07-23
---

# Local Runtime

[返回 architecture index](./index.md)

一个设备只运行一个 Local Runtime loop。默认 Runtime home 是 `~/.rollerskate/`；首次启动自动创建 LocalDevice、`<runtime>/workspace`、Owner Principal、唯一 `Local` Chat、承载它的 Local Topic 与 loop state，不依赖 Server 登录。显式 `--runtime <absolute-path>` 用于隔离测试实例；旧 repo-local `.rollerskate/` 不再参与默认发现。

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

owner chat.message
  -> mention / system dispatch card
  -> chat.dispatch + Agent Execution
  -> agent chat.message | silent | failed audit fact
```

## Canonical Event

`local/src/core/event/model.ts` 是 Event source of truth。所有 Event 都包含全局 `evt_` UUIDv7、固定 `type`、source、可选 Principal/Session/Destination，以及 `rootEventId/parentEventId/hop` 因果关系。`chat.message` 保存 `topicId`、sender、body、resolved target/handle snapshot 或 dispatch card；`chat.dispatch` 保存同一 `topicId`、源 message、目标 Principal 与 Agent prompt。

- CLI 与 Subscription 在本地构造 Event 并生成统一 ID。
- Matrix projection 构造新的 Rollerskate Event，并以 Matrix event ID 作为外部幂等键。
- v0.4 Server ingress 必须原样保存 Server 已生成的 Rollerskate Event ID，不能建立第二个语义副本。
- 用户入口不接受任意 Event envelope；每种 ingress 只接受自己的固定 schema。

`RuntimeStore.appendEvent` 原子保存 Event 与唯一 Execution。旧 `inputs → TriggerRouter → Work[]`、generic emit 和独立 Event store 已移除。

源码中的 core 位于 `local/src/core/`，其中 `core/loop.ts` 拥有唯一长期运行的 loop、cycle 调度、pause/stop 生命周期和顶层异常隔离。`bootstrap/runtime.ts` 只创建固定的 application service、第一方 Capability 与 integration，再交给 core loop 驱动；它不拥有第二个 loop，也不允许 Capability 启动自己的 daemon。完整 ownership 见 [Source map](./source-map.md)。

## Route 与 Handler

Route 只表示需要程序执行的 `Event.type → Handler kind`。`agent.request`、`subscription.fire` 与 `chat.dispatch` 路由到 `AgentHandler`；`agent.result` 路由到 `ResultHandler`。`chat.message` 是已经建模并直接持久化的 typed outcome，不创建无意义 Execution。

`AgentHandler` 调用由 Principal identity 选择的 provider adapter，并由 Execution 持久化有限指数退火重试。传统 Agent input 成功或最终失败仍创建 `agent.result` fallback；Local Chat 的 message outcome 直接创建 Agent sender `chat.message`，silent 只终止 Execution，failure 只写 Execution/audit facts。

Matrix Room 不是本地 Route。它是 ingress binding 和可选 Destination：Matrix 消息先转换成输入 Event，`agent.result` 之后才按 Destination 建立 Delivery。

## Capability 与 Plugin

Subscription 是第一方 bundled Capability：它随 Rollerskate 源码、migration、测试和发布交付，由项目负责运行稳定性。Capability 可以通过固定 ingress 产生预先注册的 Event，但不能绕过 core 或建立并列 loop。

用户 Plugin 不是 Capability，也不是 Handler。它只能实现 Capability 预先声明的受限 strategy slot；当前唯一 slot 是 `subscription.probe@1`。Plugin 不能注册 Event type、Route、Handler、loop 或 store，不能直接调用 Agent 或访问 Runtime。完整信任边界见 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。

## Session、恢复与异常隔离

Session 保存本地 Session ID、Agent Principal、adapter、workspace 与 provider session ID。每个 Local Agent 在 `Local` 中有独立 current Session；后续 dispatch 默认续接，New session 只清空该 Agent 的 current pointer 并提高 generation，不删除旧 Session 或 Chat history。

中断恢复只把 `running` Execution 与 `delivering` Delivery 放回有限重试状态。已经 terminal 的 Agent Execution 不重放 provider 调用。

## 审计

SQLite 是本机持久事实源。Console 的 Runtime 与 Events 提供系统审计；Agents 提供 Local Agent 生命周期；Chats 通过固定 `/api/chat` schema API 追加 owner message、dispatch 与 New session。没有 generic Event write API，Event history 不提供修改或删除。

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
