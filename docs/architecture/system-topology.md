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
| Client | 计划 | 登录 Server，创建或选择 Agent，发送聊天与控制请求，查看状态。 |
| Server | Phase 1–3 已实现并验收 | Node.js BFF、OIDC/Device/Agent、Room control plane、Matrix AS、MySQL projection 与 head/range/stream。 |
| Matrix | Server/Local adapter 与隔离真实 Room Gate 已验收 | Server 与 Local Runtime 之间的网络 Event bus；保留 room/thread/message transport facts。 |
| Local Runtime | `v0.3.0` unified core 已实现 | canonical Event、Agent sandbox workspace、Session、Subscription、单 Handler loop、Destination delivery、Console 审计与停止权。 |
| Agent provider | Codex adapter 已实现 | 在 Local 授予的 cwd、sandbox/permission mode、预算和进程边界内执行 Agent invocation。 |

Server 源码位于 `server/`，当前已提供身份、Device/Agent 和 Room API；Local Runtime 通过 Server Room head/range/send adapter 接入 Matrix，并将投影转换成 canonical Event。Loopback Console 只读展示本地执行审计；完整 Server Event ingress 留到 v0.4。

## Deployment invariants

- 一个 Server deployment 长期只服务一个可信 team；deployment 是登录准入、public Room 可见性和数据隔离边界，不在实例内部再建 Organization/tenant 层。
- OAuth/OIDC authentication 不自动授予 deployment access；Human 必须命中实例 invite/allowlist，首个 `admin` 由部署配置 bootstrap，只有 `admin` 可以管理 Human 准入。
- 一个用户可以登录多台电脑；每台电脑是一个独立设备 identity。
- 每台电脑只有一个 Local Runtime，多个 Agent 共享该进程，但拥有独立 name、workspace 与授权状态。
- 一个 Agent 同一时刻只绑定一个 Home Runtime。两台电脑不能同时以同一 Agent identity 独立推进状态。
- Home Runtime 离线时，Server 标记 Agent unavailable，但不建立面向 Agent 的离线补推队列，也不把 Agent 自动漂移到另一台电脑。
- Local Matrix binding 上线后按自己的 read-through cursor 与 Server 返回的 Room head 拉取有界区间；每个合格投影构造一个 canonical Event，旧 Core Chat Handler cursor 不再存在。
- Agent 显式迁移后，新设备重新建立 workspace，并重新批准额外 path 与 secrets；Server 不复制本地授权。

## Authority boundary

Server 拥有网络可达的 identity、产品 Object/Event、placement desired state 和 Room history；Local Runtime 拥有实际执行、sandbox workspace、数据访问、canonical Event 执行事实、Session、receipt 与最终停止权。Matrix 拥有 transport history。Client 和 Local 不保存 Server、Matrix 或 provider 信息的完整副本。

Client 对 Server 发出的 `name` 是 Agent identity 的最小创建输入。Local 收到 placement 后，在本地 provision `<workspace>/<name>`；额外访问必须经过设备侧明确同意。

## Change guidance

- 若设计要求同一 Agent 同时运行在多个设备，必须先替代 [ADR 0001](./adrs/0001-local-authority-and-agent-placement.md)，并明确冲突合并、secrets、workspace 和消息 exactly-once 语义。
- Server API 不应直接接受任意本地 path、secret value 或 SQLite state。
- 新 transport 必须作为 Event adapter 接入，不能另建一套 collaboration core。
- 新 Local cache 必须有 bounded retention 和回源路径，不能因离线便利升级成 Server/Matrix 的完整副本。
