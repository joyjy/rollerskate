---
type: Architecture
title: Rollerskate Source Of Truth
description: 产品、网络、本地运行、Agent 与 workspace 数据的权威归属。
tags: [rollerskate, source-of-truth, ownership, data]
timestamp: 2026-07-17
---

# Source Of Truth

[返回 architecture index](./index.md)

## Ownership map

| 事实 | 权威系统 | Rollerskate 的其他层如何使用 |
| --- | --- | --- |
| 用户登录、设备 identity、Agent identity、Home placement | Server | Local 接收 desired placement，但保留本地执行否决权。 |
| Matrix room、thread、sender、message history | Matrix | Adapter 保存最小 transport reference 与 delivery evidence。 |
| 产品 identity、Agent、placement、Room/membership/binding 与产品 Event projection | Server | Client 和 Local 只保存当前操作需要的投影与引用。 |
| Local execution Event、trust decision、work/lease/result/outbox | Local Runtime SQLite | 只对本机执行与恢复权威；payload 按 working-set retention 清理，不构成产品完整历史。 |
| Agent sandbox workspace | Local filesystem / owner | 是本地执行空间，不是 Server、Matrix 或 provider 数据的副本；Runtime 保存 canonical root 与授权引用。 |
| 额外 path、secret grant、pause/stop decision | Local Runtime / owner | Server 可请求，不能自行授予或读取值。 |
| Agent provider session/tool execution | Agent provider | Runtime 保存 invocation state、receipt 与必要摘要。 |
| 用户聊天展示与待投递消息 | Server projection + Matrix transport | Local 仅暂存未消费内容、最小 reference、result 与 delivery receipt。 |
| 当前架构事实 | `docs/architecture/` + source | 未实现计划不能覆盖已实现事实。 |

## Data movement limits

- Client 和 Local 不在本地保存 Server、Matrix 或 Agent provider 的完整信息副本；只保留当前操作与恢复需要的有界投影、引用和 payload。
- Server 不同步整个 workspace、Local SQLite、path grant 或 secret value。
- Local 调用外部 Agent provider 时，只在明确 sandbox/cwd 与用户知情边界内发送完成请求所需上下文。
- Matrix history 留在 Matrix；Local 只保存未消费 working set，以及幂等、correlation、trace 与 reply 所需的最小事实。
- Agent 迁移到另一设备时，workspace 数据迁移与额外授权是显式流程，不由 placement 自动隐式复制。

## Local retention classes

- 未消费消息正文：保留到 Attention Turn 消费、明确过期或被 Server 撤回。
- 失败或待重试内容：保留到恢复完成或达到 bounded TTL。
- 已消费内容：清除正文，只保留 remote event reference、hash、cursor、decision 与 receipt。
- `delta.md` 等 context artifact：Attention Turn 结束后清理；需要历史时通过 Server BFF 查询 Matrix，而不是要求 Local 永久搜索。
- 本地授权、runtime state 与 receipt：按本机恢复和审计需要持久化，但不能包含完整远端对象副本。

## Change guidance

任何新增同步或本地缓存字段都必须回答：谁创建、谁可修改、离线时谁权威、冲突如何解决、为何必须落本地、何时清理、是否包含敏感数据以及如何撤销。无法回答时，不得加入 Server/Local 协议或 Local SQLite。
