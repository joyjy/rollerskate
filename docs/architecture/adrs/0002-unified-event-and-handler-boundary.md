---
type: Decision
title: ADR 0002 - Unified Event And Handler Boundary
description: 决定所有 ingress 使用统一 Event，并把协议适配、持久化与产品 handler 分离。
tags: [rollerskate, adr, event, handler, adapter]
timestamp: 2026-07-17
---

# ADR 0002: Unified Event And Handler Boundary

- Status: Accepted
- Baseline: `v0.1.0`

## Context

早期计划把 Command、Event、Response、Schedule、Input Ledger、Work Inventory 和 collaboration 分别提升为核心抽象。实现验证表明，它们需要共享 trace、dedupe、source 与持久化入口，但仍可通过 Event type 保留语义；聊天选择也不应进入协议 adapter 或 Event Store。

## Decision

- 所有 ingress 规范化为一个协议中立 Event；Command、observation、Response 和 schedule firing 是 Event type。
- Event adapter 只负责协议 authentication、mapping、provider evidence 与 delivery reference。
- Event Store 只保存、去重和查询 Event，不筛选 chat，不生成 Turn。
- Runtime 持有内部 trigger、work、lease、capability、outbox 与 observe。
- Handler 只承载随 Rollerskate 源码发布的产品语义。早期设想的可安装 Plugin Handler 已由 [ADR 0005](./0005-capability-and-plugin-boundary.md) 否决；用户 Plugin 不能注册 Event type、Route 或 Handler。
- Chat Handler 从 Event/Runtime result 形成并推进聊天；是否引入独立 Turn 模型由未来真实 UI/continuation 需求决定。

## Consequences

协议可以替换，Event persistence 保持中立，产品语义有明确承载层；代价是 handler 必须显式声明输入 state 和幂等边界，不能依赖 transport-specific convenience state。

## Revisit trigger

只有当某类输入无法在统一 trace、dedupe、source 和 lifecycle contract 中安全表达，或显式 Turn 成为跨 handler 的稳定业务对象时，才重新评估。

[返回 architecture index](../index.md)
