---
type: Architecture
title: Rollerskate Architecture
description: Rollerskate 当前系统形状、默认阅读路径、稳定边界和按工作域组织的架构入口。
tags: [rollerskate, architecture, local-runtime, server]
timestamp: 2026-07-25
---

# Rollerskate Architecture

## 30 秒架构

Rollerskate 当前是 Local-first Agent proactive system。每台电脑运行一个 Local Runtime，拥有本机 identity、workspace、Chat、Agent、durable state 和唯一 core loop；首次启动不依赖 Server、OIDC 或 Device enrollment。Server 与 Matrix 的既有代码不接管本机 workspace、权限、执行与停止权；schema v43 已移除旧 Local binding/ingress state，新的 Server Agent authentication、Topic/TransportBinding 与 cursor/session persistence 在 v0.4 重建。

```text
Owner / Console / fixed ingress
  -> Local Runtime
     -> canonical Event
     -> exactly one Handler
     -> durable Execution / Session / Delivery
     -> Agent or Capability outcome

Optional remote control
  -> Server BFF -> Matrix -> Local Runtime admission
```

当前架构记录已实现到 v0.3.10 的事实。公开源码快照只包含已实现源码、architecture 与 runbook，不分发内部 plan 和 release verification。

## 默认阅读路径

- 只想理解系统：读完本页即可。
- 修改 Local Runtime 或 Console：继续读 [Local Runtime](./local-runtime.md)，再按改动选择一个专题文档。
- 修改 Server、Matrix、跨设备 identity 或 placement：继续读 [System topology](./system-topology.md)。
- 判断某类数据或状态归谁：直接查 [Source of truth](./source-of-truth.md)。

ADR、Source map 和 Event Reference 都是按需材料，不是理解系统的前置阅读。

## 按工作域进入

### Local Runtime 机制

- [Local Runtime](./local-runtime.md)：Local-first 基础设施、模块边界、canonical Event、Route/Handler、Session、审计与单进程 loop。
- [Event and Handler flow](./event-and-chat-flow.md)：Event、Execution、Handler、result、Destination 与 Local Chat 主链。
- [State and recovery](./state-and-recovery.md)：SQLite、lease、outbox、Agent invocation、crash 与恢复语义。
- [Source of truth](./source-of-truth.md)：身份、消息、配置、运行状态、远端 working set 与本地数据的权威归属。

### Capability

- [Poll Subscription](./poll-subscription.md)：轮询、受限 probe Plugin slot、durable one-shot fire 与控制面。
- [Local Scheduled Task](./scheduled-task.md)：Schedule revision、cron/timezone、misfire/overlap、Session policy 与 unknown recovery。
- [Local Multi-Client Review](./local-review.md)：versioned subject/evidence、MRSF、双 Agent authority、durable projection 与有限返修。

只在修改对应 Capability 时读取该专题；它们不是默认架构阅读路径。

### Server 与远端控制面

- [System topology](./system-topology.md)：Server、Matrix、Local Runtime、Agent 与设备 placement。
- [Server foundation](./server-foundation.md)：Node.js/MySQL 基线、共享协议、credential 与 migration 边界。
- [Room control plane](./room-control-plane.md)：Room/membership/binding、Matrix AS、cursor/range 与在线 stream。

### 维护参考

- [Source map](./source-map.md)：workspace、源码 root、ownership、共享 contract、生成关系与验证入口。
- [Event Reference](./event-reference.md)：Local canonical Event、Runtime object 与 Server/Matrix EventEnvelope。
- [Database Reference](./db-reference.md)：Event / index / object 建模规范，以及 Local SQLite schema v43 的 13 张物理 table、ownership、authority 与迁移规则。

Source map 只在修改 source root、ownership、共享 contract、生成关系或验证入口时读取；Event Reference 只在查询或修改 Event schema/type 与 Runtime object 时读取；Database Reference 在设计或修改 Local SQLite table、migration、materialized index/projection 或 durable object/state 时读取。

### 长期决策

- [ADR 0001](./adrs/0001-local-authority-and-agent-placement.md)：Local authority 与单 Home Runtime placement。
- [ADR 0002](./adrs/0002-unified-event-and-handler-boundary.md)：统一 Event、adapter 与 handler 边界。
- [ADR 0003](./adrs/0003-local-data-minimization.md)：Local 不保存 Server、Matrix 或 provider 信息的完整副本。
- [ADR 0004](./adrs/0004-single-team-deployment.md)：一个 deployment 长期只服务一个可信 team，不建立猜测性的 Organization/tenant 模型。
- [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)：第一方 Capability 随源码发布，用户 Plugin 只能实现受限 strategy slot。

只有准备改变对应长期边界时才需要读取 ADR。

## 跨域不变量

- 每台电脑最多运行一个 Local Runtime；本机 workspace、授权、执行状态与停止权始终由 Local/Owner 掌握。
- 所有 ingress 先成为 canonical Event，再按 `Event.type` 进入唯一 Handler；transport adapter 不拥有产品处理语义。
- `core/loop.ts` 拥有唯一长期运行 loop；Capability 和 integration 不能建立平行 daemon 或 execution core。
- Local 只保存本机执行、恢复和 bounded working set 所需事实，不复制 Server、Matrix 或 provider 的完整信息。
- 网络身份不等于执行权限；每种固定 ingress 必须建立自己的 admission 边界，不能开放 generic Event write。
- 一个 Server deployment 是单 team 的身份、Room 可见性和数据隔离边界；public Room 只在该 deployment 内公开。

## 变更指引

- 改 Server/Local ownership、Agent placement、同步或数据复制：检查 [System topology](./system-topology.md)、[Source of truth](./source-of-truth.md) 与 ADR 0001/0003/0004。
- 改 Event schema、adapter、handler、Event Store 或主链：检查 [Local Runtime](./local-runtime.md)、[Event flow](./event-and-chat-flow.md)、[Event Reference](./event-reference.md) 与 ADR 0002。
- 改 Local SQLite table、migration、主键、owner、materialized index/projection 或 durable object/state：先按 [Database Reference](./db-reference.md) 完成分类，再更新物理表登记并执行对应 schema/store 验证。
- 改 durable state、retry、lease、shutdown、recovery 或 Capability 状态机：更新 [State and recovery](./state-and-recovery.md) 与对应 Capability 专题，并保留 crash/restart/duplicate/unknown 证据。
- 改 Capability/Plugin 信任边界：检查对应 Capability 专题与 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。
- 改 source root、ownership、共享 contract、生成关系或验证入口：同步 [Source map](./source-map.md)。
- 新增产品能力：只有实现并通过项目验证后，才把当前事实迁入本 bundle。
- 用户操作和排障步骤属于 [runbook](../runbook/quickstart.md)；实现过程和内部 release evidence 不回填到公开架构入口。
