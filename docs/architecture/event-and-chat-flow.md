---
type: Architecture
title: Event and Handler Flow
description: canonical Event 从固定 ingress 经唯一 Handler、result Event 到 Destination 的当前主链。
tags: [rollerskate, event, route, handler, delivery]
timestamp: 2026-07-23
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

Route 不是房间、地址或 transport。它只保存 `Event.type → Handler kind`，不返回数组、不 fanout，也没有 Observer。Matrix Room 属于 ingress binding 和 Destination。

## ID 与幂等

- 本地 ingress 生成 `evt_` UUIDv7。
- Server Event 保留已有 `evt_` ID。
- Matrix 等非 Rollerskate 协议 ID 保存为 `source.externalId`，用于同一 source 下幂等。
- Handler 输出仍使用统一 `evt_` ID；Session、Destination 与 Delivery 使用各自统一前缀 ID。
- 后续处理必须创建带 `rootEventId/parentEventId/hop` 的新 Event。

## Result Event 边界

`AgentHandler` 只能完成自己的 Execution，并原子创建固定 schema 的 `agent.result` Event 及其 queued Execution。`agent.result` 通过 Route 只进入 `ResultHandler`；ResultHandler 负责把 Event 上的显式 Destination 转成 Delivery，不调用 Agent。Destination adapter 只交付，不重新调用业务 Handler。

Agent Execution 使用有限指数退火；达到上限后生成 outcome=`failed` 的 `agent.result` Event。ResultHandler 自己的 Execution 同样有限重试，但最终失败不再生成 result Event，避免递归。Execution/Delivery 的异常按记录隔离，不能终止 Local Runtime loop。

## Trust boundary

v0.3 不接受 generic command envelope，因此没有通用 `command + subject + grant` router。权限在固定 ingress 建立：CLI 只访问本机 active Agent；Subscription 使用已注册的 Session；Matrix 只处理 Server 返回的 Agent binding，并应用 wake policy。Server admission 与 route 重构留到 v0.4。

只有随源码发布的第一方 Capability 可以通过固定 ingress 产生预先注册的 Event。用户 Plugin 不能注册 Event type、Route 或 Handler，只能在 Capability host 内返回受限声明式结果；详见 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。
