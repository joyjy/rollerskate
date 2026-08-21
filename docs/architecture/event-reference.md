---
type: Reference
title: Rollerskate Event Reference
description: Local canonical Event、Runtime object 与 Server/Matrix EventEnvelope 的完整当前清单和边界。
tags: [rollerskate, event, runtime, chat, topic, room, server, matrix]
timestamp: 2026-07-26
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

Event type、Runtime work object、Capability object 与产品 read model 不属于同一层。下表是当前主要对象的分类；只有第一行的六种对象属于 Local canonical Event type。

| 对象 | 分类 | 持久化与可变性 | Owner | 与 Event 的关系 |
|---|---|---|---|---|
| `agent.request`、`subscription.fire`、`agent.result`、`chat.activation`、`chat.message`、`chat.dispatch` | Local canonical Event | `events` 表中的 immutable fact | `core/event` | 因果链的稳定节点；每种类型由固定 Route 驱动 |
| Runtime structured log event | 运行日志 | stdout/log sink，不进入 `events` 表 | `core/loop`、`bootstrap/runtime` | 描述运行过程，不参与 canonical Event route |
| Server/Matrix `EventEnvelope` | 远端 transport envelope | Server Room history | `packages/protocol`、Server event module | 可被 Local ingress 投影成新的 Local Event，但不是同一对象 |
| `RuntimeExecution` | Runtime work index | `executions` 表中的 mutable lifecycle | `core/runtime` | 每个 routed Event 对应一次 Handler work；记录 claim、retry 与终态 |
| `RuntimeSession` | Runtime continuity object | `agent_sessions` 表中的 mutable provider binding | `core/runtime` | 被 Agent input/result/chat Event 引用，不是 Event |
| `RuntimeDestination` | Runtime admission snapshot | Event 中保存 bounded endpoint snapshot，Delivery 再固定 kind/address；没有独立 table | `core/runtime` | Event admission 固定实际投递端点，避免 retry 被后续配置变化改写 |
| `RuntimeDelivery` | Runtime work index | `deliveries` 表中的 mutable lifecycle和 immutable Destination snapshot | `core/runtime` | `agent.result` 按 Event snapshot 建立 Delivery；Loop 驱动投递与重试 |
| `RuntimeRoute`、Handler | 静态规则与行为组件 | 源码固定，不是业务数据 | `core/runtime`、application/Capability handler | 把 Event type 映射到唯一 Handler |
| Loop、Cycle | Runtime orchestrator | 只有进程生命周期状态 | `core/loop` | 驱动 Execution、Delivery 与第一方 Capability，不是 Event 或 index object |
| Subscription、Schedule、ScheduledRun | Capability domain/work object | 各 Capability 的 durable mutable state | `capabilities/*` | 可产生或消费固定 Event，但不加入全局 Event type 列表 |
| StewardRun | application/runtime coordination object | `agent_runs` 的 durable lifecycle/current checkpoint、`agent_run_decisions` 的 immutable decision audit；transcript 留在 Event/Execution | `application/steward` | 以 generic `agent.request/result` 接收 Agent 结果，再由 autonomous callback 或 caller `RunDecision@1` 推进；不增加 Steward 专用 Event type |
| ChatPresence、attention receipt、decision receipt | Chat policy/index object | Presence 在 `chat_presence`；两个 receipt 使用对应 `executions.receipt_json` 的 versioned schema | `core/chat`、`core/runtime` | 由 `chat.message`/`chat.dispatch` 处理更新，不是 Chat Event |
| ChatMessage projection、read progress | Application projection | `chat_messages` 可从 Event、attention receipt 与 dispatch Execution 完整重建 | `application/chat`、`infrastructure/sqlite/chat-store` | 不拥有 message content 或用户 read cursor；只解释 Agent processing progress |
| RuntimeAudit、Console view | Application read model | 查询时组装，不是独立 canonical fact | `application/*/query` | 只读取 Event 和 Runtime/Capability object，不参与 route |
| Notice projection、Notice state | Application projection + authoritative user state | `notices` 的 derived columns 可重建；read/ack columns 不可从 Event 重建 | `application/notice`、`infrastructure/sqlite/notice-store` | 从 `agent.result` 与 Delivery snapshot 投影，通过稳定 reference 与 Runtime Failure/Subscription/Event 互相下钻，不参与 route |

## Event route 与派生对象

| Canonical Event type | Route | 主要派生或更新的对象 |
|---|---|---|
| `agent.request` | AgentHandler | Execution、Session，最终产生子 `agent.result`；带 run context 时属于一个 Agent Run step |
| `subscription.fire` | AgentHandler | Execution、Session，最终产生子 `agent.result` |
| `agent.result` | ResultHandler | Execution；按 `destinationIds` 建立 Delivery；按 generic run context 建立 autonomous delegate/callback/terminal，或 caller checkpoint |
| `chat.activation` | ChatHandler | Execution、attention receipt，可在没有 Human message 时产生零个或多个 `chat.dispatch` |
| `chat.message` | ChatHandler | Execution、attention receipt，可产生零个或多个 `chat.dispatch` |
| `chat.dispatch` | AgentHandler | Execution、Session、decision receipt，可产生 Agent `chat.message` |

Notice 不是 Event type。`application/notice` 通过 `notices` 读取由 `agent.result` 与 RuntimeDelivery Destination snapshot 形成的 bounded 产品视图；同表的 derived columns 可以重建，read/ack columns 不能，rebuild 必须保留后者。Runtime 继续只拥有通用 Delivery 生命周期，不加入 Notice 专用 Event type、query 或 state。

## Local canonical Event 公共字段

六种 Local canonical Event 都包含：

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
- `subscription`：Subscription `agent.invoke` callback admission。
- `schedule`：ScheduledRun admission；`externalId` 固定为 `scheduled-run:<runId>`，用于修复 Event 已建立但 run 尚未链接的 crash window。
- `matrix`：Matrix Room projection。
- `server`：预留给 Server Event ingress。
- `handler`：Runtime Handler 或 Local Chat system 产生的后继 Event。

用户入口不能提交任意 Event envelope；每个入口只能构造自己的固定 schema。

## `agent.request`

向一个 Agent 发起一次请求。普通 CLI/Schedule/Subscription request 可以独立存在；Agent Run step 复用同一 Event type。

- 特有字段：`agentId`、`prompt`，可选 `sessionId` 与 host-owned `runContext`。
- `AgentRunContext@1` 只包含通用协调信息：`runId`、`stepId`、可选 `parentStepId`、按 orchestration mode 选择的 result contract、effective workspace grant snapshot，以及 autonomous mode 可选的 immutable completion callback binding。它不包含 workflow、Reviewer/Implementer、Caller decision 或其他领域字段。
- callback request 还携带 bounded `AgentStepCompletion@1`，记录 child request/result/Execution、terminal outcome、summary、artifact references 与 observed workspace revision；它恢复 admission 时固定的 caller Session。
- 当前生产者：`scripts/rs agent request`、Local Scheduled Task。旧 Matrix ingress binding 已随 schema v43 cutover 移除；v0.4 transport ingress 通过 Server-assigned canonical Event 进入。
- Route：`AgentHandler`。
- 成功结果：创建子 `agent.result`，包含不透明 output 和 Session；存在 result contract 时由注册 continuation 后续校验。
- 最终失败：创建失败的子 `agent.result`。
- 外部投递：输入携带的 `destinationIds` 复制到 `agent.result`，再由 ResultHandler 建立 Delivery。

## `subscription.fire`

Subscription terminal callback 请求 Agent invocation。

- 特有字段：`agentId`、`prompt`、可选 `sessionId`、immutable terminal `observation` 与 `SubscriptionAgentInvocation@1` authority snapshot。
- `observation` 保存 Plugin 返回的 `version`、`terminal`、可选 `summary` 与 bounded `facts`；callback 不需要重新探测外部系统。
- `source.kind`：`subscription`。
- `source.externalId`：durable callback occurrence ID，用于每个 trigger occurrence 的 exactly-once admission。
- Route：`AgentHandler`。
- Agent invocation 固化 `ExternalWorkspaceGrant@1`、独立 `networkAccess` 与 `SubscriptionAgentResult@1` contract；adapter 只能按该 snapshot 启用 workspace write/network。Agent 的结构化 `blocked` 不等同于 provider 进程成功，Capability continuation 将其保存为 callback 与 Subscription 的 durable blocked outcome。
- 成功或最终失败：创建子 `agent.result`。
- 外部投递：由独立 `destination.deliver` callback 表达，不从 Agent result 隐式派生。

非 terminal probe、普通 poll attempt、pause/resume/cancel 都不是 canonical Event；它们只更新 Subscription state 或产生 Runtime log。

## `agent.result`

Agent input 的 typed terminal result。

- 特有字段：`agentId`、`outcome`；成功时有不透明 `output`，失败时有 `error`，可带 `sessionId`。Core 不把 Agent Run 的 `AgentTurnResult@1` 或 `AgentStepResult@1` 解析结果复制到 Event payload。
- `source.kind`：`handler`。
- Parent：对应的 `agent.request` 或 `subscription.fire`。
- Route：`ResultHandler`。
- 作用：根据 `destinationIds` 建立零个或多个 Delivery。存在 run context 时，generic ResultHandler 根据 `resultContractId` 路由唯一 continuation：`agent-turn-result@1` 解析 `complete | delegate` 并建立最多一个 child/callback 或 terminal state；`agent-step-result@1` 写入 checkpoint 并进入 `awaiting_orchestrator`。`RunDecision@1` 由 Owner 通过 Steward application control 单独提交，不是 Event result contract。Core 和 ResultHandler 都不解释 workflow-specific output。Matrix 默认最多重试五次；macOS notification 只尝试一次，失败不修改 `agent.result`。

`agent.result` 不承载 Local Chat 的 Agent 回复。程序已明确接管的 Chat outcome 直接写成 `chat.message`；silent 或最终失败只保留 Execution/audit fact。

## `chat.activation`

Topic 策略产生的 immutable attention root，使 Agent 可以在没有新 Human message 时主动首发或继续推进。

- 特有字段：`topicId`、`reason`、`strategyId`、`strategyRevision`、`contextRevision`、稳定排序并去重的 `candidateAgentIds`、`turnBudget`、`expiresAt`，可选 `sourceEventId`。
- 当前可执行策略：Local Console 暴露 `starter` 和 `manual`；同一 Local conversation root 中的 Agent message 通过 `participant-message` 进入同一 ChatHandler 路径。Server Topic Agent event 在协议没有携带可验证的 activation/cycle token 前只进入 timeline，不自动创建新的 attention root，避免每次跨 Runtime 回帖重新获得预算。`scheduled` 与 `resumed` 只保留在版本化 Event vocabulary 中，当前没有 Console 或 Scheduled Task admission，不能据此宣称已交付。
- `source.externalId`：由 application 提供的 activation idempotency key；相同 key 只创建一个 Event/Execution。
- Route：`ChatHandler`。Presence、Agent lifecycle、candidate snapshot 与 expiry 共同决定 dispatch/skip receipt。
- `turnBudget` 是整个 activation root 的 dispatch 上限；Store 在同一 immediate transaction 中按 `rootEventId` 计数并截停后续 dispatch。预算耗尽、全部 silent、全部 skip 或 expiry 都是确定性停止，不产生伪造 Human message。
- activation 只授予一次 Chat attention，不增加工具、网络、文件系统、effect 或执行 authority。

## `chat.message`

唯一 Local Chat `Local` 中的 immutable message。

- 特有字段：`topicId`、`sender`、`body`。
- `sender.kind`：`owner`、`agent` 或 `system`。
- `sender` 同时保存 `principalId`（如适用）与 `handleSnapshot`，后续 rename 不改历史。
- Owner message 可带 resolved `target`。
- 旧 System message 可能带 `dispatchCard`；该字段只用于读取 v0.3.1 历史，新消息不再创建 card。
- Agent message 可带 `agentId` 与 `sessionId`，并以对应 `chat.dispatch` 为 Parent。
- 新的 Human root message 带 `human-message` conversation budget；后续 Local Agent reply 继承同一 `rootEventId`，因此不能以新 message 绕过整轮预算。没有可验证 cycle token 的 Server Agent message 不带 conversation budget、也不创建 Chat Execution；旧 schema 中没有该 snapshot 的历史 root 保持可读。

每条新的 Owner 或 Agent message 都创建一个 `ChatHandler` Execution。ChatHandler 对全部 Local Agent 应用 target、sender、lifecycle status 和 Topic/Global presence，原子写入每个 Agent 的 attention receipt，并为 dispatched Agent 建立 `chat.dispatch`。明确 `@handle` 在 admission 时解析为稳定 target snapshot；未指定 target 时不会要求 Owner 单选，available Agent 各自决定是否发言。Server Topic 的 Agent event 也会按 server event ID 幂等投影为 Agent sender message；本机发布形成的 server echo 通过原始 transaction/Event ID 跳过，避免同一发言二次唤醒。

`chat_messages` 只是上述 Event 与 Execution 的 rebuildable application projection。Owner message 上的 read progress 表示对应 Agent Execution 是否成功处理，不是 Human/Agent 用户 read cursor；完整 authority 和 rebuild 规则见 [Database Reference](./db-reference.md)。

## `chat.dispatch`

把一条 Owner/Agent message 或 Topic activation 分发给一个 Local Agent。

- 特有字段：`agentId`、`topicId`、`sourceAttentionEventId`、`targetHandleSnapshot`、`promptResourceId`、rendered `prompt`，可带 current `sessionId`。message-triggered dispatch 同时保留 `sourceMessageEventId` 兼容字段。
- `source.kind`：`handler`。
- `source.externalId`：包含源 message ID 的本地 dispatch 幂等键。
- Parent：被分发的 `chat.message` 或 `chat.activation`。
- Route：`AgentHandler`，创建唯一 queued Execution。
- Agent 必须返回 `ChatDecision@1`：speech 为 `reply | silent`，其中 silent 必须携带最多 200 字的 bounded reason；presence 为 Topic/Global `available | snoozed`。
- message-triggered dispatch 为 Codex、Claude Code 与 Pi 公布并装配真实的只读 `read_chat_history` tool。tool 固定当前 Topic，首个 cursor 可接在 prompt 的 bounded history 之前，后续只能使用上一页返回的 cursor；每次 invocation 最多读取 20 页、累计返回 1 MiB。Kimi ACP adapter 当前未装配动态 MCP server，因此只对 Kimi 公布 `ChatHistoryRequestCapability@1`，保留同 Session `ChatHistoryRequest@1` bounded continuation。该能力读取 Rollerskate Topic，不等同于下述 same-client provider history。
- Codex 获得 active same-client grant 时，rendered prompt 公布 `ClientThreadToolsCapability@1`，adapter 只在该次 `chat.dispatch` 注册真实的 `list_client_threads` 与 `read_client_thread` MCP tools。list 接受精确 ISO 时间窗并枚举 active/archived Codex task，read 只接受 list 返回的 opaque reference；Codex 不再使用或解析 `ClientHistoryRequest@1`。
- 非 Codex Agent 在 rendered prompt 包含 `ClientHistoryCapability@1` 时，仍可先返回至多三次 `ClientHistoryRequest@1 search | read`。`application/chat/agent-continuation.ts` 装饰通用 Agent adapter，在同一 provider Session 内返回 bounded、redacted `ClientHistoryResult@1`，再要求原始 Chat decision；Core `AgentHandler` 不解析 history request schema。未授权或 adapter 没有可验证的 same-client provider policy receipt 时 prompt 不公布能力，初始 prompt 永不预载 client history。
- 成功且 reply：原子保存 decision/presence 并创建 Agent sender 的子 `chat.message` 及其 ChatHandler Execution。
- 成功且 silent：原子保存 decision/presence，只结束 Agent Execution。
- 最终失败：只记录 failed Execution/audit fact，不创建 `agent.result`。

同一 attention source 对同一 Agent 最多建立一次 attention receipt 和 `chat.dispatch`。active Global snooze 优先于 Topic；直接 mention、对应 scope 的 literal wake keyword 或 snooze 到期只让 Agent重新执行一次决策，不能替 Agent决定回复或后续 presence。

same-client history authority 独立保存在 Runtime 私有 `client-history-access.json`，不进入 Event payload、SQLite 或 Server。grant 固定 Owner、Agent 与 client。Codex list 每次最多枚举 31 天、50 个 active/archived task，排除当前与本次 invocation 之后启动的 session；read 最多扫描 8 MiB 并返回 64 KiB 脱敏消息。非 Codex search/read 保持原有 provider-root、32 MiB scan、20 个 match 与 64 KiB read window 边界。每次 list/search/read 都重新验证 grant 与 adapter 从实际受限 argv 推导并签发的 provider policy fingerprint；Codex 还必须把 policy environment 从 shell 排除，只显式传给 MCP server。grant、成功或失败的 list/search/read、coverage/truncation 与 revoke 都追加 bounded durable audit；policy/source 缺失、source unsupported、revoked、跨 Owner、跨 client、未知 reference 与总 context 超限均 fail closed。

## Canonical 因果链

传统请求：

```text
agent.request | subscription.fire
  -> agent.result
  -> zero or more Delivery
```

Steward Run（包括 versioned workflow）：

```text
run start -> Steward agent.request [runId, stepId]
  autonomous -> agent.result [AgentTurnResult@1]
    complete -> succeeded | failed | needs_human
    delegate -> child result -> AgentStepCompletion@1 callback
  caller -> agent.result [AgentStepResult@1]
    -> AgentRunCheckpoint@1 + awaiting_orchestrator
    -> Owner RunDecision@1 -> next agent.request | terminal
```

Local Chat：

```text
owner | agent chat.message
  -> ChatHandler
  -> zero or more chat.dispatch + per-Agent skip receipts
  -> ChatDecision@1
  -> agent chat.message | silent | failed Execution

chat.activation [starter | manual | scheduled]
  -> ChatHandler
  -> bounded chat.dispatch
  -> agent chat.message
  -> participant-message attention until budget/silence/expiry stop
```

## Runtime log event

以下记录是 loop stdout 中的结构化 JSON，不进入 canonical `events` 表，不拥有 `evt_` ID，也不经过 Handler route：

### `runtime.adapter_unavailable`

启动装配 Agent 或 Matrix adapter 失败。字段包括 `adapter`、`agentId` 与 `error`；Runtime 跳过该 adapter 后继续启动其余能力。

### `subscription.cycle`

一次有实际工作的 Subscription phase。字段包括：

- `polled`：本轮尝试的 Subscription ID。
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
- `thread/start|resume`、`turn/start`、`item/completed`、`turn/completed`：Codex app-server runner 读写的外部 LF-delimited JSON-RPC message；只投影为内部 runner receipt，不进入 Core Event schema。
- Execution、Session、Destination snapshot、Delivery、Subscription、Schedule、ScheduledRun、AgentRun、ChatMessage projection、workflow/artifact 与 Agent lifecycle status：独立 durable object/state，不是 Event type。

## 查看与变更

- Events UI：查看六种 Local canonical Event 及其 Execution、Result、Session、Delivery 和因果关系。
- Runtime UI：查看 loop health、workload 与 isolation；structured log 当前输出到 loop stdout，不代替 Event history。
- Chats UI：只显示 `chat.message`；`chat.dispatch` 留在 Event trace，并以 Owner message 上的 Agent processing progress ring 表达 read/reading/unread/failed。
- CLI：`scripts/rs trace <event-id>` 查看一个 canonical Event 的审计链；`scripts/rs schedule trace <run-id>` 从 ScheduledRun 查看同一 audit；`scripts/rs run trace <run-id>` 查看完整 Agent request/result/callback chain。完整命令见 [CLI Command Reference](../runbook/cli-reference.md)。

新增 canonical Event type 时，必须同时修改 Event model、SQLite constraint、唯一 Route、Handler/typed outcome、UI type、测试与本文。新增 Runtime log event 不得混入 canonical Event type registry。
