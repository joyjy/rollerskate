---
type: Reference
title: Rollerskate Event Reference
description: Local canonical Event、Runtime object 与 Server/Matrix EventEnvelope 的完整当前清单和边界。
tags: [rollerskate, event, runtime, chat, topic, room, server, matrix]
timestamp: 2026-07-25
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

## 对象分类

Event type、Runtime work object、Capability object 与产品 read model 不属于同一层。下表是当前主要对象的分类；只有第一行的七种对象属于 Local canonical Event type。

| 对象 | 分类 | 持久化与可变性 | Owner | 与 Event 的关系 |
|---|---|---|---|---|
| `agent.request`、`subscription.fire`、`agent.result`、`review.requested`、`review.decision`、`chat.message`、`chat.dispatch` | Local canonical Event | `events` 表中的 immutable fact | `core/event` | 因果链的稳定节点，通过固定 Route 驱动后续处理 |
| Runtime structured log event | 运行日志 | stdout/log sink，不进入 `events` 表 | `core/loop`、`bootstrap/runtime` | 描述运行过程，不参与 canonical Event route |
| Server/Matrix `EventEnvelope` | 远端 transport envelope | Server Room history | `packages/protocol`、Server event module | 可被 Local ingress 投影成新的 Local Event，但不是同一对象 |
| `RuntimeExecution` | Runtime work index | `executions` 表中的 mutable lifecycle | `core/runtime` | 每个 routed Event 对应一次 Handler work；记录 claim、retry 与终态 |
| `RuntimeSession` | Runtime continuity object | `agent_sessions` 表中的 mutable provider binding | `core/runtime` | 被 Agent input/result/chat Event 引用，不是 Event |
| `RuntimeDestination` | Runtime admission snapshot | Event 中保存 bounded endpoint snapshot，Delivery 再固定 kind/address；没有独立 table | `core/runtime` | Event admission 固定实际投递端点，避免 retry 被后续配置变化改写 |
| `RuntimeDelivery` | Runtime work index | `deliveries` 表中的 mutable lifecycle和 immutable Destination snapshot | `core/runtime` | `agent.result` 按 Event snapshot 建立 Delivery；Loop 驱动投递与重试 |
| `RuntimeRoute`、Handler | 静态规则与行为组件 | 源码固定，不是业务数据 | `core/runtime`、application/Capability handler | 把 Event type 映射到唯一 Handler |
| Loop、Cycle | Runtime orchestrator | 只有进程生命周期状态 | `core/loop` | 驱动 Execution、Delivery 与第一方 Capability，不是 Event 或 index object |
| Subscription、Schedule、ScheduledRun、ReviewChainProjection | Capability domain/work/projection object | 各 Capability 的 durable mutable state | `capabilities/*` | 可产生或消费固定 Event，但不加入全局 Event type 列表 |
| ChatPresence、attention receipt、decision receipt | Chat policy/index object | Presence 在 `chat_presence`；两个 receipt 使用对应 `executions.receipt_json` 的 versioned schema | `core/chat`、`core/runtime` | 由 `chat.message`/`chat.dispatch` 处理更新，不是 Chat Event |
| RuntimeAudit、Console view | Application read model | 查询时组装，不是独立 canonical fact | `application/*/query` | 只读取 Event 和 Runtime/Capability object，不参与 route |
| Notice projection、Notice state | Application projection + authoritative user state | `notices` 的 derived columns 可重建；read/ack columns 不可从 Event 重建 | `application/notice`、`infrastructure/sqlite/notice-store` | 从 `agent.result` 与 Delivery snapshot 投影，通过稳定 reference 与 Runtime Failure/Subscription/Event 互相下钻，不参与 route |

## Event route 与派生对象

| Canonical Event type | Route | 主要派生或更新的对象 |
|---|---|---|
| `agent.request` | AgentHandler | Execution、Session，最终产生子 `agent.result` |
| `subscription.fire` | AgentHandler | Execution、Session，最终产生子 `agent.result` |
| `agent.result` | ResultHandler | Execution；按 `destinationIds` 建立 Delivery |
| `review.requested` | ReviewHandler | Execution、ReviewChainProjection、Reviewer `agent.request` |
| `review.decision` | ReviewHandler | Execution、ReviewChainProjection，可产生 Implementer `agent.request` 或下一轮 `review.requested` |
| `chat.message` | ChatHandler | Execution、attention receipt，可产生零个或多个 `chat.dispatch` |
| `chat.dispatch` | AgentHandler | Execution、Session、decision receipt，可产生 Agent `chat.message` |

Notice 不是 Event type。`application/notice` 通过 `notices` 读取由 `agent.result` 与 RuntimeDelivery Destination snapshot 形成的 bounded 产品视图；同表的 derived columns 可以重建，read/ack columns 不能，rebuild 必须保留后者。Runtime 继续只拥有通用 Delivery 生命周期，不加入 Notice 专用 Event type、query 或 state。

## Local canonical Event 公共字段

七种 Local canonical Event 都包含：

- `eventId`：`evt_` 前缀 UUIDv7，全局生成后不再改变。
- `type`：固定为本文列出的七种类型之一。
- `source`：包含 `kind`，可包含用于幂等的 `externalId`。
- `agentId`：仅与某个 Agent 相关的 Event 使用。
- `sessionId`：需要绑定或续接 Agent Session 时使用。
- `destinationIds`：传统 result 需要投递到外部 Destination 时使用；admission 同时固定对应 bounded Destination snapshots，Local Chat Event 通常为空。
- `causality`：`rootEventId`、可选 `parentEventId` 与 `hop`。
- `createdAt`：ISO-8601 时间。

允许的 `source.kind`：

- `cli`：CLI 或 Local UI/application admission。
- `subscription`：Poll Subscription terminal fire。
- `schedule`：ScheduledRun admission；`externalId` 固定为 `scheduled-run:<runId>`，用于修复 Event 已建立但 run 尚未链接的 crash window。
- `matrix`：Matrix Room projection。
- `server`：预留给 Server Event ingress。
- `handler`：Runtime Handler 或 Local Chat system 产生的后继 Event。

用户入口不能提交任意 Event envelope；每个入口只能构造自己的固定 schema。

## `agent.request`

向一个 Agent 发起传统的一次请求。

- 特有字段：`agentId`、`prompt`，可选 `sessionId`。
- Review 生成的 request 还带固定 `reviewInvocation`：role、root/cycle、subject/artifact/evidence revision、workspace access 与 result schema。该字段不能由普通 CLI request 自由提交。
- 当前生产者：`scripts/rs agent request`、Local Scheduled Task。旧 Matrix ingress binding 已随 schema v43 cutover 移除；v0.4 transport ingress 通过 Server-assigned canonical Event 进入。
- Route：`AgentHandler`。
- 成功结果：创建子 `agent.result`，包含 output 和 Session。
- 最终失败：创建失败的子 `agent.result`。
- 外部投递：输入携带的 `destinationIds` 复制到 `agent.result`，再由 ResultHandler 建立 Delivery。

## `subscription.fire`

Poll Subscription 得到 terminal observation 后发起固定 callback。

- 特有字段：`agentId`、`prompt`、已绑定的 `sessionId`，以及 immutable terminal `observation`。
- `observation` 保存 Plugin 返回的 `version`、`terminal`、可选 `summary` 与 bounded `facts`；callback 不需要重新探测外部系统来恢复已知终态。旧 schema 历史 Event 可能没有该字段。
- `source.kind`：`subscription`。
- `source.externalId`：Subscription ID，用于 exactly-once fire 去重。
- Route：`AgentHandler`。
- 成功或最终失败：创建子 `agent.result`。
- 外部投递：terminal fire 携带一个由 Subscription title 驱动的 `macos-notification` Destination；成功或最终失败的子 `agent.result` 都建立一次通知 Delivery。

非 terminal probe、普通 poll attempt、pause/resume/cancel 都不是 canonical Event；它们只更新 Subscription state 或产生 Runtime log。

## `agent.result`

传统 Agent input 的 typed 执行结果。

- 特有字段：`agentId`、`outcome`；成功时有 `output`，失败时有 `error`，可带 `sessionId`。
- `source.kind`：`handler`。
- Parent：对应的 `agent.request` 或 `subscription.fire`。
- Route：`ResultHandler`。
- 作用：根据 `destinationIds` 建立零个或多个 Delivery。Matrix 默认最多重试五次；macOS notification 只尝试一次，失败不修改 `agent.result`。

`agent.result` 不承载 Local Chat 的 Agent 回复。程序已明确接管的 Chat outcome 直接写成 `chat.message`；silent 或最终失败只保留 Execution/audit fact。

## `review.requested`

请求 Reviewer 针对一个固定 acceptance subject 与 workspace evidence 执行检查。

- 特有字段：`cycleIndex`、subject ref/revision、artifact ref/可选 revision、evidence、implementation revision、Reviewer/Implementer Agent ID 与 rework limit。
- 首次 `source.kind` 为 `cli`；返修后的下一轮为 `handler`。
- Route：固定 ReviewHandler。
- 作用：验证 subject/artifact/workspace revision 与两个 adapter 的 result/authority 能力，再事务性建立 Reviewer `agent.request`。

## `review.decision`

Reviewer 结构化 result 经 Capability 校验和 MRSF mutation 后形成的固定 decision。

- 特有字段：cycle、对应 request/result Event、`passed | findings | blocked`、bounded summary、实际读取的 revisions、artifact revision、open finding count 与可选 blocked reason。
- `source.kind`：`handler`。
- Route：固定 ReviewHandler。
- `passed` 或 `blocked` 终止 projection；`findings` 在 rework limit 内事务性建立 Implementer `agent.request`，否则终止为 blocked。

## `chat.message`

唯一 Local Chat `Local` 中的 immutable message。

- 特有字段：`topicId`、`sender`、`body`。
- `sender.kind`：`owner`、`agent` 或 `system`。
- `sender` 同时保存 `principalId`（如适用）与 `handleSnapshot`，后续 rename 不改历史。
- Owner message 可带 resolved `target`。
- 旧 System message 可能带 `dispatchCard`；该字段只用于读取 v0.3.1 历史，新消息不再创建 card。
- Agent message 可带 `agentId` 与 `sessionId`，并以对应 `chat.dispatch` 为 Parent。

每条新的 Owner 或 Agent message 都创建一个 `ChatHandler` Execution。ChatHandler 对全部 Local Agent 应用 target、sender、lifecycle status 和 Topic/Global presence，原子写入每个 Agent 的 attention receipt，并为 dispatched Agent 建立 `chat.dispatch`。明确 `@handle` 在 admission 时解析为稳定 target snapshot；未指定 target 时不会要求 Owner 单选，available Agent 各自决定是否发言。

## `chat.dispatch`

把一条 Owner 或 Agent message 分发给一个 Local Agent。

- 特有字段：`agentId`、`topicId`、`sourceMessageEventId`、`targetHandleSnapshot`、`promptResourceId`、rendered `prompt`，可带 current `sessionId`。
- `source.kind`：`handler`。
- `source.externalId`：包含源 message ID 的本地 dispatch 幂等键。
- Parent：被分发的 Owner `chat.message`。
- Route：`AgentHandler`，创建唯一 queued Execution。
- Agent 必须返回 `ChatDecision@1`：speech 为 `reply | silent`，presence 为 Topic/Global `available | snoozed`。
- 成功且 reply：原子保存 decision/presence 并创建 Agent sender 的子 `chat.message` 及其 ChatHandler Execution。
- 成功且 silent：原子保存 decision/presence，只结束 Agent Execution。
- 最终失败：只记录 failed Execution/audit fact，不创建 `agent.result`。

同一 source message 对同一 Agent 最多建立一次 attention receipt 和 `chat.dispatch`。active Global snooze 优先于 Topic；直接 mention、对应 scope 的 literal wake keyword 或 snooze 到期只让 Agent重新执行一次决策，不能替 Agent决定回复或后续 presence。

## Canonical 因果链

传统请求：

```text
agent.request | subscription.fire
  -> agent.result
  -> zero or more Delivery
```

Local Review：

```text
review.requested
  -> Reviewer agent.request -> agent.result
  -> review.decision
  -> Implementer agent.request -> agent.result -> next review.requested
  -> review.decision passed | blocked
```

Local Chat：

```text
owner | agent chat.message
  -> ChatHandler
  -> zero or more chat.dispatch + per-Agent skip receipts
  -> ChatDecision@1
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

### `scheduled_task.cycle`

一次有实际工作的 Scheduled Task phase。字段包括：

- `projected`：从关联 Execution 回投新状态的 run ID。
- `admitted`：本轮建立或重新链接 canonical `agent.request` 的 run ID。
- `skipped`：misfire/overlap policy 形成的 bounded skipped run ID。
- `queued`：进入或更新单槽 pending 的 run ID。
- `failed`：Agent、workspace 或 fixed Session admission validation 失败的 run ID。

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

当前 Server Matrix Application Service 只把 `m.room.message` 写入 Server Room Event history；`eventId` 保留 Matrix event ID，`adapter.transport` 是 `matrix`。v0.4 将由 Server Topic/TransportBinding 规范化并可靠投递，Local 不再维护 v42 的独立 Matrix ingress binding table。

Server `EventEnvelope.type` 当前没有封闭的 Rollerskate 产品类型注册表。测试中的 `room.message.received`、`placement.desired` 只是 schema fixture，不是已注册的产品 Event。

## 容易误认成 Event 的类型

以下名称不是 Rollerskate canonical Event：

- `subscription.probe`：用户 Plugin strategy slot kind。
- `reply`、`silent`、`request_history`、`compact`：Agent/Room action contract。
- `thread.started`、`item.completed`、`turn.completed`：provider adapter 读取的外部进程 JSONL record。
- Execution、Session、Destination snapshot、Delivery、Subscription、Schedule、ScheduledRun、Review aggregate、MRSF artifact 与 Agent lifecycle status：独立 durable object/state，不是 Event type。

## 查看与变更

- Events UI：查看七种 Local canonical Event 及其 Execution、Result、Session、Delivery 和因果关系；v0.3.5 只扩展既有 schema/filter，没有新增 Review 页面或 mutation。
- Runtime UI：查看 loop health、workload 与 isolation；structured log 当前输出到 loop stdout，不代替 Event history。
- Chats UI：只投影 `Local` 的 `chat.message` 与 `chat.dispatch`。
- CLI：`scripts/rs trace <event-id>` 查看一个 canonical Event 的审计链；`scripts/rs schedule trace <run-id>` 从 ScheduledRun 查看同一 audit；`scripts/rs review trace <root-event-id>` 查看完整 Review chain；完整命令见 [CLI Command Reference](../runbook/cli-reference.md)。

新增 canonical Event type 时，必须同时修改 Event model、SQLite constraint、唯一 Route、Handler/typed outcome、UI type、测试与本文。新增 Runtime log event 不得混入 canonical Event type registry。
