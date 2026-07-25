---
type: Architecture
title: Rollerskate System Topology
description: Server、Matrix、Local Runtime、设备、Agent 与客户端之间的稳定边界。
tags: [rollerskate, topology, server, local-runtime, matrix]
timestamp: 2026-07-19
---

# System Topology

[返回 architecture index](./index.md)

## 当前与计划状态

| 节点 | 状态 | 职责 |
| --- | --- | --- |
| Local Console | `v0.3.1` 已实现 | 无登录管理 Local Agent、唯一 `Local` Chat、Runtime、Events 与 Subscriptions。 |
| Server Client | 计划 | 登录 Server，管理 Server Room、remote identity 与连接。 |
| Server | Phase 1–3 已实现并验收 | Node.js BFF、OIDC/Device/Agent、Room control plane、Matrix AS、MySQL projection 与 head/range/stream。 |
| Matrix | Server/Local adapter 与隔离真实 Room Gate 已验收 | Server 与 Local Runtime 之间的网络 Event bus；保留 room/thread/message transport facts。 |
| Local Runtime | `v0.3.1` Local-first product 已实现 | 自动 Local foundation、共享 workspace、Principal/Agent、immutable `Local` Chat、Session、Subscription、单 loop、Console 与停止权。 |
| Agent provider | Codex、Claude Code 与 Kimi Code adapter 已实现 | 在 Local 授予的 cwd、sandbox/permission mode、预算和进程边界内执行 Agent invocation；Kimi Code 在受信任本机上只承担 Review Implementer，不承担 Reviewer。 |

Server 源码位于 `server/`，当前已提供身份、Device/Agent 和 Room API；这些能力不参与 Local 首次启动。Local Runtime 可以通过保留的 Server Room head/range/send adapter 接入 Matrix，但 v0.3.1 Local UI 不展示 Server connection、binding 或 Server Room。完整 Server Event ingress 留到 v0.4。

## Deployment invariants

- 一个 Server deployment 长期只服务一个可信 team；deployment 是登录准入、public Room 可见性和数据隔离边界，不在实例内部再建 Organization/tenant 层。
- OAuth/OIDC authentication 不自动授予 deployment access；Human 必须命中实例 invite/allowlist，首个 `admin` 由部署配置 bootstrap，只有 `admin` 可以管理 Human 准入。
- 一个用户可以登录多台电脑；每台电脑是一个独立设备 identity。
- 每台电脑只有一个 Local Runtime；Local Agent 共享 `<runtime>/workspace` 文件内容，但拥有独立 Principal、Execution、Session 与 credential。
- 一个 Agent 同一时刻只绑定一个 Home Runtime。两台电脑不能同时以同一 Agent identity 独立推进状态。
- Home Runtime 离线时，Server 标记 Agent unavailable，但不建立面向 Agent 的离线补推队列，也不把 Agent 自动漂移到另一台电脑。
- Local Matrix binding 上线后按自己的 read-through cursor 与 Server 返回的 Room head 拉取有界区间；每个合格投影构造一个 canonical Event，旧 Core Chat Handler cursor 不再存在。
- Agent 显式迁移后，新设备重新建立 workspace，并重新批准额外 path 与 secrets；Server 不复制本地授权。

## Authority boundary

Local Runtime 拥有 LocalDevice、Owner/Agent Principal、共享 workspace、`Local` Event history、实际执行、Session、receipt 与最终停止权。Server 拥有网络可达的 remote identity、产品 Object/Event、placement desired state 和 Server Room history；Matrix 拥有 transport history。Local 不保存 Server、Matrix 或 provider 信息的完整副本。

Local Console 创建 Agent 时接受 handle、受支持的 client 与逐项 argv 启动参数；Principal ID 由本地生成。adapter 始终拥有协议、Session、workspace 和权限参数，用户配置不能覆盖这些边界。未来 Server binding 使用 `(principalId, serverConnectionId)` 建立独立 remote identity；Local identity 不自动与 OIDC Human 或 remote Agent 合并。

## Change guidance

- 若设计要求同一 Agent 同时运行在多个设备，必须先替代 [ADR 0001](./adrs/0001-local-authority-and-agent-placement.md)，并明确冲突合并、secrets、workspace 和消息 exactly-once 语义。
- Server API 不应直接接受任意本地 path、secret value 或 SQLite state。
- 新 transport 必须作为 Event adapter 接入，不能另建一套 collaboration core。
- 新 Local cache 必须有 bounded retention 和回源路径，不能因离线便利升级成 Server/Matrix 的完整副本。
