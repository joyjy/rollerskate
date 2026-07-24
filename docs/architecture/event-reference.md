---
type: Reference
title: Rollerskate Event Reference
description: Local canonical Event、Runtime log event 与 Server/Matrix EventEnvelope 的完整当前清单和边界。
tags: [rollerskate, event, runtime, chat, topic, room, server, matrix]
timestamp: 2026-07-24
---

# Rollerskate Event Reference

[返回 architecture index](./index.md)

本文是当前 Event 的单一人类可读索引。`local/src/core/event/model.ts` 是 Local canonical Event type 与字段的事实源；`packages/protocol/src/index.ts` 是 Server/Local 网络 `EventEnvelope` 的事实源；`local/src/bootstrap/runtime.ts` 与 `local/src/core/loop.ts` 是 Runtime structured log event 的事实源。源码与本文不一致时以源码为准，并应在同一次修改中更新本文。

## 三种 event

Rollerskate 中有三个不同层次的 event：

- **Local canonical Event**：保存在本机 SQLite `events` 表，拥有 `evt_` UUIDv7、因果关系与不可变 payload；Events UI 和 `scripts/rs trace` 查看这一层。
- **Runtime log event**：前台 loop 输出的结构化 JSON 运行记录；Runtime UI 属于这一层，不参与 canonical Event route。
- **Server/Matrix EventEnvelope**：Server 保存的远端 Room transport envelope；当前主要承载 Matrix `m.room.message`，不等同于 Local canonical Event。

Runtime 与 Events 因此保持独立的 UI 导航入口。

## Local canonical Event 公共字段

五种 Local canonical Event 都包含：

- `eventId`：`evt_` 前缀 UUIDv7，全局生成后不再改变。
- `type`：固定为本文列出的五种类型之一。
- `source`：包含 `kind`，可包含用于幂等的 `externalId`。
- `agentId`：仅与某个 Agent 相关的 Event 使用。
- `sessionId`：需要绑定或续接 Agent Session 时使用。
- `destinationIds`：传统 result 需要投递到外部 Destination 时使用；Local Chat Event 通常为空。
- `causality`：`rootEventId`、可选 `parentEventId` 与 `hop`。
- `createdAt`：ISO-8601 时间。

允许的 `source.kind`：

- `cli`：CLI 或 Local UI/application admission。
- `subscription`：Poll Subscription terminal fire。
- `matrix`：Matrix Room projection。
- `server`：预留给 Server Event ingress。
- `handler`：Runtime Handler 或 Local Chat system 产生的后继 Event。

用户入口不能提交任意 Event envelope；每个入口只能构造自己的固定 schema。

## `agent.request`

向一个 Agent 发起传统的一次请求。

- 特有字段：`agentId`、`prompt`，可选 `sessionId`。
- 当前生产者：`scripts/rs agent request`；legacy Matrix ingress 会把合格的远端 Room message 投影成此类型。
- Route：`AgentHandler`。
- 成功结果：创建子 `agent.result`，包含 output 和 Session。
- 最终失败：创建失败的子 `agent.result`。
- 外部投递：输入携带的 `destinationIds` 复制到 `agent.result`，再由 ResultHandler 建立 Delivery。

## `subscription.fire`

Poll Subscription 得到 terminal observation 后发起固定 callback。

- 特有字段：`agentId`、`prompt`、已绑定的 `sessionId`。
- `source.kind`：`subscription`。
- `source.externalId`：Subscription ID，用于 exactly-once fire 去重。
- Route：`AgentHandler`。
- 成功或最终失败：创建子 `agent.result`。

非 terminal probe、普通 poll attempt、pause/resume/cancel 都不是 canonical Event；它们只更新 Subscription state 或产生 Runtime log。

## `agent.result`

传统 Agent input 的 typed 执行结果。

- 特有字段：`agentId`、`outcome`；成功时有 `output`，失败时有 `error`，可带 `sessionId`。
- `source.kind`：`handler`。
- Parent：对应的 `agent.request` 或 `subscription.fire`。
- Route：`ResultHandler`。
- 作用：根据 `destinationIds` 建立零个或多个 Delivery。

`agent.result` 不承载 Local Chat 的 Agent 回复。程序已明确接管的 Chat outcome 直接写成 `chat.message`；silent 或最终失败只保留 Execution/audit fact。

## `chat.message`

唯一 Local Chat `Local` 中的 immutable message。

- 特有字段：`topicId`、`sender`、`body`。
- `sender.kind`：`owner`、`agent` 或 `system`。
- `sender` 同时保存 `principalId`（如适用）与 `handleSnapshot`，后续 rename 不改历史。
- Owner message 可带 resolved `target`。
- System message 可带 `dispatchCard`，其中保存源 message 和当时可选的 Agent。
- Agent message 可带 `agentId` 与 `sessionId`，并以对应 `chat.dispatch` 为 Parent。

Owner 明确 `@handle` 时，message admission 原子创建 `chat.message` 和一次 `chat.dispatch`。没有 target 时，loop 后续追加一条带单选 card 的 system `chat.message`。`chat.message` 已经是程序拥有的 typed outcome，不创建自己的通用 Execution。

## `chat.dispatch`

把一条 Owner message 分发给一个 Local Agent。

- 特有字段：`agentId`、`topicId`、`sourceMessageEventId`、`targetHandleSnapshot`、`prompt`，可带 current `sessionId`。
- `source.kind`：`handler`。
- `source.externalId`：包含源 message ID 的本地 dispatch 幂等键。
- Parent：被分发的 Owner `chat.message`。
- Route：`AgentHandler`，创建唯一 queued Execution。
- 成功且 Agent 回复：创建 Agent sender 的子 `chat.message`。
- 成功但 silent：只结束 Execution，不创建结果 Event。
- 最终失败：只记录 failed Execution/audit fact，不创建 `agent.result`。

同一条 Owner message 最多成功建立一次 `chat.dispatch`；重复选择返回已有 receipt。

## Canonical 因果链

传统请求：

```text
agent.request | subscription.fire
  -> agent.result
  -> zero or more Delivery
```

Local Chat：

```text
owner chat.message
  -> chat.dispatch
  -> agent chat.message | silent | failed Execution
```

无明确 target：

```text
owner chat.message
  -> system chat.message with dispatchCard
  -> chat.dispatch
  -> agent chat.message | silent | failed Execution
```

## Runtime log event

以下记录是 loop stdout 中的结构化 JSON，不进入 canonical `events` 表，不拥有 `evt_` ID，也不经过 Handler route：

### `runtime.adapter_unavailable`

启动装配 Agent 或 Matrix adapter 失败。字段包括 `adapter`、`agentId` 与 `error`；Runtime 跳过该 adapter 后继续启动其余能力。

### `subscription.cycle`

一次有实际工作的 Subscription phase。字段包括：

- `polled`：本轮尝试的 Subscription ID。
- `fired`：成功产生 `subscription.fire` 的 `{subscriptionId, eventId}`。
- `failed`：poll phase 的 `{subscriptionId, phase, error}`。

### `matrix.ingress_cycle`

一个 legacy Matrix binding 的 ingress phase。字段包括 `bindingId`、`destinationId`、`roomId`、`readThrough`、`scanned`、`acceptedEventIds` 与 `ignoredExternalIds`。

### `local_chat.dispatch_prompted`

loop 为未指定目标的 Owner message 创建 system dispatch card。字段 `messageEventIds` 指向本轮新建的 system `chat.message`。

### `runtime.cycle`

一次有实际工作的 core Runtime phase。字段包括已处理的 `executions`、`deliveries` 与按 `phase/id/error` 记录的 `failures`。

### `runtime.cycle_failed`

某个 loop phase 抛出顶层异常。字段包括 `scope`、可选 `bindingId` 与 `error`；异常被隔离，loop 继续后续 cycle。

## Server/Matrix EventEnvelope

共享协议的 `EventEnvelope` 是开放 type 的远端 transport envelope，公共字段为：

- `protocolVersion`：当前为 `1`。
- `eventId`、`type`、`occurredAt`。
- 可选 `traceId`。
- `source` 与可选 `subject`：Principal kind 为 `human`、`device`、`agent` 或 `server`。
- `payload`：JSON value。
- 可选 `adapter`：`transport` 与 transport-specific `metadata`。

当前 Server Matrix Application Service 只把 `m.room.message` 写入 Server Room Event history；`eventId` 保留 Matrix event ID，`adapter.transport` 是 `matrix`。Local Matrix ingress 再按 binding policy 把合格 envelope 投影为新的 Local `agent.request`，并把远端 event ID 保存为 `source.externalId`。

Server `EventEnvelope.type` 当前没有封闭的 Rollerskate 产品类型注册表。测试中的 `room.message.received`、`placement.desired` 只是 schema fixture，不是已注册的产品 Event。

## 容易误认成 Event 的类型

以下名称不是 Rollerskate canonical Event：

- `subscription.probe`：用户 Plugin strategy slot kind。
- `reply`、`silent`、`request_history`、`compact`：Agent/Room action contract。
- `thread.started`、`item.completed`、`turn.completed`：provider adapter 读取的外部进程 JSONL record。
- Execution、Session、Destination、Delivery、Subscription 与 Agent lifecycle status：独立 durable object/state，不是 Event type。

## 查看与变更

- Events UI：查看五种 Local canonical Event 及其 Execution、Result、Session、Delivery 和因果关系。
- Runtime UI：查看 loop health、workload 与 isolation；structured log 当前输出到 loop stdout，不代替 Event history。
- Chats UI：只投影 `Local` 的 `chat.message` 与 `chat.dispatch`。
- CLI：`scripts/rs trace <event-id>` 查看一个 canonical Event 的审计链；完整命令见 [CLI Command Reference](../runbook/cli-reference.md)。

新增 canonical Event type 时，必须同时修改 Event model、SQLite constraint、唯一 Route、Handler/typed outcome、UI type、测试与本文。新增 Runtime log event 不得混入 canonical Event type registry。
