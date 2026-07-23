---
type: Decision
title: ADR 0003 - Local Data Minimization
description: 决定 Rollerskate client 不在本地保存 Server、Matrix 或 provider 信息的完整副本。
tags: [rollerskate, adr, local, retention, privacy]
timestamp: 2026-07-17
---

# ADR 0003: Local Data Minimization

- Status: Accepted
- Baseline: `v0.2.0` planning

## Context

Local Runtime 需要在断线、重启、Agent failure 和 delivery retry 后继续正确推进，因此必须保存部分 Inbox、cursor、Turn、invocation 与 receipt。若把这种恢复需求实现成完整 Matrix history、Server Object/Event 或 provider session 副本，Local 会形成竞争事实源，并扩大磁盘、隐私、迁移和多设备一致性成本。Agent sandbox workspace 是本地执行空间，不属于远端信息副本。

## Decision

- Rollerskate client 不在本地保存 Server、Matrix 或 Agent provider 的完整信息副本。
- Matrix 保存完整聊天历史；Server 保存产品 identity、Agent、placement、Object/Event 与产品投影；Agent provider 保存自己的 session/tool execution 事实。
- Local SQLite 只保存本机执行与恢复所需的最小 envelope/reference、未消费 working payload、cursor、policy、Turn、invocation、outbox 和 receipt。
- 已消费 payload 按 bounded retention 清理，只留下幂等、审计与恢复所需的 reference/hash/decision/receipt。
- 临时 delta/context artifact 在 Turn 结束后清理；历史不足时通过 Server BFF 回源 Matrix。
- 离线能力不得自动扩大本地复制范围；需要更长离线窗口时，显式调整 working-set TTL，而不是建立全量镜像。

## Consequences

Local 数据更小，设备迁移和隐私边界更清楚，也不会与 Server/Matrix 争夺事实归属。代价是超出 working window 的历史查询依赖网络，retention 和回源必须成为可测试的 handler contract，且 Server/Matrix 不可用时 Agent 只能基于现有 delta 行动或保持沉默。

## Revisit trigger

只有出现经过验证的长期离线产品需求，并能定义加密、容量、删除、冲突和重新同步语义时，才重新评估某类远端数据的本地完整副本。

[返回 architecture index](../index.md)
