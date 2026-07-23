---
type: Architecture
title: Rollerskate Architecture
description: Rollerskate v0.3 canonical Event Local Runtime、Server/Matrix 边界、稳定不变量和变更入口。
tags: [rollerskate, architecture, local-runtime, server]
timestamp: 2026-07-19
---

# Rollerskate Architecture

## 状态与范围

本 bundle 记录当前有效的产品与实现架构。`v0.2.0` 建立企业 OIDC、Device/Agent identity、Room control plane 与 Matrix BFF；`v0.3.0` 将设备侧执行收敛为 canonical Event、单 Handler Route、`agent.result` Event/Destination、one-shot Subscription 与 loopback Console。Server Event ingress 与 Server route 重构留到 v0.4。代码改变稳定边界时，必须在同一次变更中更新对应 architecture shard。

Rollerskate 的产品结构是中心 Server 与用户设备上的 Local Runtime。Server 提供身份、设备和消息控制面；Local Runtime 持有 workspace、权限、secrets、执行状态、proactive loop 和停止权。Matrix 是网络 Event bus，Server 是面向产品客户端的 BFF，不是本地执行事实源。

```text
Human / Agent client
  -> Server BFF (Human admission and Device routes implemented)
  -> Matrix event bus
  -> Local Runtime (implemented)
  -> input Event -> AgentHandler -> agent.result Event -> ResultHandler -> optional Destination
```

## 架构地图

- [Source map](./source-map.md)：workspace、源码 root、ownership、共享 contract、生成关系与验证入口。
- [System topology](./system-topology.md)：Server、Matrix、Local Runtime、Agent 与设备 placement。
- [Server foundation](./server-foundation.md)：Node.js/MySQL 基线、共享协议、credential 与 migration 边界。
- [Room control plane](./room-control-plane.md)：Room/membership/binding、Matrix AS、cursor/range 与在线 stream。
- [Local Runtime](./local-runtime.md)：七个稳定模块、依赖方向与单进程 eventloop。
- [Event and Handler flow](./event-and-chat-flow.md)：canonical Event、单 Handler Route、result Event 与 Destination 主链。
- [Poll Subscription](./poll-subscription.md)：第一方轮询 Capability、受限 `subscription.probe` Plugin slot、durable one-shot fire 与控制面。
- [State and recovery](./state-and-recovery.md)：SQLite、lease、outbox、Agent invocation 与恢复语义。
- [Source of truth](./source-of-truth.md)：各类身份、消息、配置、运行状态和本地数据的权威归属。
- [ADR 0001](./adrs/0001-local-authority-and-agent-placement.md)：Local authority 与单 Home Runtime placement。
- [ADR 0002](./adrs/0002-unified-event-and-handler-boundary.md)：统一 Event、adapter 与 handler 边界。
- [ADR 0003](./adrs/0003-local-data-minimization.md)：Local 不保存 Server、Matrix 或 provider 信息的完整副本。
- [ADR 0004](./adrs/0004-single-team-deployment.md)：一个 deployment 长期只服务一个可信 team，不建立猜测性的 Organization/tenant 模型。
- [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)：第一方 Capability 随源码发布，用户 Plugin 只能实现受限 strategy slot。

## 关键不变量

- 每台电脑最多运行一个 Local Runtime；多个 Agent name 共享它的 eventloop 和 proactive loop。
- 每个 Agent 同一时刻只有一个 Home Runtime，默认 cwd 为 `<workspace>/<name>`；迁移必须显式发生。
- 额外 path 与 secrets 只在本地授权，不能由 Server 或网络消息隐式扩大。
- 所有 ingress 先成为协议中立的 Event；transport adapter 不拥有产品处理语义。
- Local Runtime Store 保存本机执行所需的 canonical Event、Execution、Session、Destination、Delivery 与 receipt，不是产品或聊天的完整事实源。
- Client 和 Local 不复制 Server、Matrix 或 provider 的完整信息；Matrix 保存聊天历史，Server 保存产品 identity/Object/Event，Local payload 受 working-set retention 约束。
- 网络身份不等于执行权限；每种固定 ingress 必须建立自己的 admission 边界，不能开放 generic Event write。
- Event type 只映射到一个 Handler；Room 是 Matrix ingress binding/Destination，不是 Route。
- Poll scheduler 与 probe executor 属于 Subscription；只有 terminal fire 进入 Event core。
- Server 离线不停止允许的本地 loop；Local 离线时 Agent 标记为 unavailable，不自动故障转移或积累补推队列，上线后由 Local storage 按自己的 sync gap 主动拉取。
- 一个 Server deployment 是单 team 的身份、Room 可见性和数据隔离边界；public Room 只在该 deployment 内公开。

## 变更指引

- 改 Server/Local ownership、Agent placement 或跨设备同步：先检查 [ADR 0001](./adrs/0001-local-authority-and-agent-placement.md) 和 [source of truth](./source-of-truth.md)。
- 改 Event schema、adapter、handler 或 Event Store：先检查 [ADR 0002](./adrs/0002-unified-event-and-handler-boundary.md) 和 [event flow](./event-and-chat-flow.md)。
- 改 durable state、retry、lease、shutdown 或 invocation replay：更新 [state and recovery](./state-and-recovery.md)，并保留 crash/restart 证据。
- 改 poll schedule、Plugin/probe boundary、Subscription 状态机或 continuation：更新 [Poll Subscription](./poll-subscription.md)，并保留 duplicate/restart/unknown/Session binding 证据。
- 改 Local payload、Inbox、cache、retention 或历史查询：先检查 [ADR 0003](./adrs/0003-local-data-minimization.md) 和 [source of truth](./source-of-truth.md)。
- 改成共享 SaaS、多租户或跨 deployment federation：先替代 [ADR 0004](./adrs/0004-single-team-deployment.md)，不能只给现有表补一个 `tenant_id`。
- 新增产品能力应先形成独立计划；实现并验证后迁入本 bundle。公开源码快照不包含内部计划文件。
- 用户运行与排障步骤属于 [runbook](../runbook/quickstart.md)。
