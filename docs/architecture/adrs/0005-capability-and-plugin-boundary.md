---
type: Decision
title: ADR 0005 - Capability And Plugin Boundary
description: 第一方 Capability 必须随源码发布，用户 Plugin 只能实现受限 strategy slot，不能扩展 Event core。
tags: [rollerskate, adr, capability, plugin, security]
timestamp: 2026-07-23
---

# ADR 0005: Capability And Plugin Boundary

- Status: Accepted
- Baseline: `v0.3.0`

## Context

统一 Event 与 Local Runtime loop 可以承载多种第一方玩法，但“内置功能”和“用户代码”若共用 Plugin/Handler 扩展语义，用户代码就可能获得 Event registration、后台 loop、Runtime Store、network、filesystem、process 或 secrets 权限，实际形成未受控的第三方子应用。

Subscription 已证明更窄的扩展点足够：Rollerskate 拥有 schedule、probe execution、terminal admission、Event、Session 与 retry；用户代码只需规划一次 probe 并解释受限结果。

## Decision

- Core 只拥有 Event（包括 `agent.result`）、Route、Execution、Handler、Session、Destination/Delivery 及其 lifecycle invariants。
- 随 Rollerskate 源码、migration、测试和发布一起交付的第一方玩法称为 Capability。Capability 可以在编译期贡献固定 Event type 或使用固定 Handler，但不能拥有第二个 daemon 或绕过 core。
- 当前不提供可安装 Capability、Handler、Route 或 Event type 扩展 API。第三方若要增加完整 Capability，必须修改 Rollerskate 源码并进入同一 review、migration、verification 和 release 流程。
- 用户代码统一称为 Plugin，只能实现某个 Capability 预先声明、版本化的 strategy slot。当前唯一 slot 是 `subscription.probe@1`。
- Plugin 不能注册 Event type、Route、Handler、loop、store、ingress 或 Destination，不能直接调用 Agent，也不能直接读写 Runtime facts。
- Plugin 在独立受限进程与 VM context 中运行，没有 runtime import、network、filesystem write、process spawn、secrets 或 ambient environment 权限。它只能接收 bounded JSON，并返回固定 schema 的声明式 plan/observation。
- Capability host 根据注册时不可隐式扩大的 policy 执行实际 HTTP/command probe，并拥有 timeout、output budget、allowlist、retry、terminal admission、audit 和 failure isolation。
- `Extension` 保留给未来可能出现的 operator-installed 高权限扩展，但当前没有该信任等级，也不得用 Plugin 名义提前实现。

## Consequences

Rollerskate 对 bundled Capability 的稳定性负责；Plugin failure 只影响所在 Capability item，不能改变 core lifecycle 或结束 Local Runtime loop。用户可以编写领域策略，但不能借此创建新的产品执行模型。

新增一种 Plugin slot 必须同时定义输入/输出 schema、host-owned side effects、权限 grant、资源预算、版本兼容、审计与失败语义。需要 Event/Handler registration 的需求不是 Plugin 需求，而是 Capability source change。

## Revisit trigger

只有出现真实的 operator-installed 第三方 Capability 使用方，且源码 fork/release 流程无法接受时，才设计独立 Extension trust level；不得直接放宽现有 Plugin contract。

[返回 architecture index](../index.md)
