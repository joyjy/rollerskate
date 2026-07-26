---
type: Architecture
title: Event and Handler Flow
description: canonical Event、immutable Local Chat、typed outcome、唯一 Handler 与 Destination 的当前主链。
tags: [rollerskate, event, route, handler, delivery]
timestamp: 2026-07-26
---

# Event and Handler Flow

[返回 architecture index](./index.md)

## 主链

```text
fixed ingress
  -> construct canonical Event
  -> atomically persist Event + one Execution
  -> Route(Event.type)
  -> exactly one Handler
  -> atomically persist agent.result Event + one Execution
  -> Route(agent.result)
  -> ResultHandler
  -> zero or more Delivery records for explicit Destinations
```

Event 是所有本地执行的唯一输入事实。CLI request、Subscription terminal fire 与 Matrix projection 在进入核心前都必须 Event 化；未来 Server 直接提供同一 canonical Event。

## Agent Run / completion callback 主链

```text
run start -> agent_runs + Steward agent.request [runId, stepId]
  -> agent.result [AgentTurnResult@1]
       complete -> Run terminal
       delegate one Agent
         -> child agent.request [parentStepId + fixed callback Session]
         -> child agent.result
         -> AgentStepCompletion@1 callback agent.request
         -> caller Session resumes in the same Run
```

Agent Run 不新增 `steward.*` Event 或专用 Handler。generic ResultHandler 只按 parent request 的 `resultContractId` 选择唯一 continuation；Agent Run continuation 校验 `AgentTurnResult@1`，并在同一 transaction 内完成当前 result Execution、推进 `agent_runs` CAS、建立唯一 child request 或 terminal state。child terminal success/failure 通过 host-owned callback binding 返回准确 caller Session；Agent 不选择 callback target。`review@1` 只是 versioned workflow resource，legacy `review.requested/review.decision` 保持可查但新 Runtime 不注册可写 ReviewHandler。

## Local Chat 主链

```text
owner | agent chat.message
  -> ChatHandler
  -> 对每个 Local Agent 应用 scoped presence 与 attention 状态机
     dispatch -> chat.dispatch -> AgentHandler -> ChatDecision@1
       reply -> agent chat.message -> ChatHandler
       silent -> terminal decision receipt
       available | topic/global snoozed -> durable presence
     skip -> durable attention receipt
```

Owner、system 与 Agent message 都是 immutable Event。Local Chat 固定为 `Local`，没有 CRUD 或独立 membership；ChatHandler 在 dispatch 时读取全部 Local Agent，并为每个 Agent 原子写入 dispatched/skipped attention receipt。明确 target 只 dispatch 对应 Agent；未指定 target 时所有 available Agent 都能自主判断 reply 或 silent。Presence 是 `Agent × (Global | Topic)` 的 current state，不是 Topic 配置；Agent decision 与 Owner CLI 都能更新，后写入者生效。active Global snooze 优先于 Topic，直接 mention、匹配的 literal wake keyword 与到期时间可以触发一次重新决策。旧 dispatch card Event 仍可读取，但新消息不再创建 card。

Chat 行为约束来自独立资源 `prompt.chat.free-turn`。每条新 `chat.dispatch` 保存稳定的 `promptResourceId`；attention receipt、decision receipt、presence transition、Session 与可选 reply 都进入 durable audit，不依赖 UI。

Chats timeline 只显示 `chat.message`。`chat_messages` projection 从 message Event、attention receipt 与 dispatch Execution 计算固定 Agent 分母和 `read | reading | unread | failed`；read 表示对应 Agent Execution 成功处理，reply 与 silent 等价，不是用户 read cursor。`chat.dispatch` 和 legacy dispatch card 不进入 timeline，但仍可从 canonical Event trace 检查。

Route 不是房间、地址或 transport。它只保存 `Event.type → Handler kind`，不返回数组、不 fanout，也没有 Observer。Matrix Room 属于 ingress binding 和 Destination。

## ID 与幂等

- 本地 ingress 生成 `evt_` UUIDv7。
- Server Event 保留已有 `evt_` ID。
- Matrix 等非 Rollerskate 协议 ID 保存为 `source.externalId`，用于同一 source 下幂等。
- Handler 输出仍使用统一 `evt_` ID；Session、Destination 与 Delivery 使用各自统一前缀 ID。
- 后续处理必须创建带 `rootEventId/parentEventId/hop` 的新 Event。

## Result Event 边界

`agent.result` 是传统 Agent request、Subscription callback 与 Agent Run step 的 typed terminal fact，不是 Local Chat 的通用中转层。Local Chat message outcome 直接追加 typed `chat.message`；silent 与 failure 不生成聊天 relay。`agent.result` 通过 Route 只进入 generic `ResultHandler`；ResultHandler 负责显式 Destination Delivery，或根据 run context 的 contract ID 委托已注册 continuation，不解析结果 schema，也不包含 workflow 或角色分支。single delegate/completion callback admission 属于 Agent Run continuation。

传统 Agent Execution 达到上限后生成 outcome=`failed` 的 `agent.result` Event；`chat.dispatch` 达到上限后只保留 failed Execution。ResultHandler 自己的 Execution同样有限重试，但最终失败不再生成 result Event，避免递归。Execution/Delivery 的异常按记录隔离，不能终止 Local Runtime loop。

## Trust boundary

v0.3 不接受 generic command envelope，因此没有通用 `command + subject + grant` router。权限在固定 ingress 建立：CLI 只访问本机 active Agent；Subscription 使用已注册的 Session；Matrix 只处理 Server 返回的 Agent binding，并应用 wake policy。Server admission 与 route 重构留到 v0.4。

只有随源码发布的第一方 Capability 可以通过固定 ingress 产生预先注册的 Event。用户 Plugin 不能注册 Event type、Route 或 Handler，只能在 Capability host 内返回受限声明式结果；详见 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。
