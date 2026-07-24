---
type: Decision
title: ADR 0001 - Local Authority And Agent Placement
description: 决定 Server 与 Local Runtime 的权力边界，以及每个 Agent 的单 Home Runtime placement。
tags: [rollerskate, adr, local-authority, placement]
timestamp: 2026-07-17
---

# ADR 0001: Local Authority And Agent Placement

- Status: Accepted
- Baseline: `v0.1.0`

## Context

Rollerskate 需要跨设备可达的中心控制面，同时必须让 workspace、paths、secrets、执行状态和停止权留在用户设备。允许同一 Agent 在多台电脑同时独立运行，会立即引入 workspace 合并、secret 复制、消息重复执行和冲突恢复问题。

## Decision

- Server 是身份、设备、Agent placement、Room cursor/range query 和客户端 API 的控制面。
- 每台电脑运行一个 Local Runtime；多个 Agent name 共享该 Runtime 的 eventloop。
- 每个连接 Server 的 remote Agent 同一时刻只有一个 Home Runtime。v0.3.1 Local Agent 属于其创建所在的 Local Runtime，默认 cwd 是该 Runtime 共享的 `<runtime>/workspace`；不同 Principal 的 Session、Execution 与 credential 仍隔离。
- Home Runtime 离线时 Agent unavailable；Server 不建立面向 Agent 的离线补推队列，也不自动切换设备。Local storage 上线后根据自己的 Room sync gap 主动拉取区间；Core Chat Handler 的 Agent cursor 不参与 storage 同步。
- Agent 换设备必须显式迁移；新设备重新批准额外 path 与 secrets。
- Local Runtime 对网络请求保留最终授权、执行和停止权。

## Consequences

优点是权限与数据归属清楚，离线本地 loop 可继续，第一版无需分布式状态合并。代价是 Home Runtime 离线时 Agent 暂不可用，用户需要显式迁移，并且 Server UI 必须准确展示 placement/unavailable 状态。

## Revisit trigger

只有出现明确的多设备同时执行需求，并能给出 workspace、secret、Event、delivery 与 Agent memory 的冲突模型时，才重新评估 multi-home。

[返回 architecture index](../index.md)
