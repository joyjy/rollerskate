---
type: Decision
title: ADR 0004 - Single-Team Deployment Boundary
description: 决定一个 Rollerskate Server 实例长期只服务一个可信 team，并以 deployment 作为身份、Room 可见性和数据隔离边界。
tags: [rollerskate, adr, deployment, identity, room]
timestamp: 2026-07-17
---

# ADR 0004: Single-Team Deployment Boundary

- Status: Accepted
- Baseline: `v0.2.0` planning

## Context

Rollerskate 的预期使用方式是每个 team 自行部署一个实例，当前实际用户也只有部署者自己的 team。若提前加入 Organization、tenant membership 和跨租户授权，会把尚不存在的 SaaS 多租户需求扩散到 identity、Agent、Room、cursor、Session 与所有 Server 查询。

## Decision

- 一个 Rollerskate Server deployment 只服务一个可信 team；deployment 本身是身份目录、管理和数据隔离边界。
- OAuth/OIDC 只证明 Human identity；进入 deployment 还必须命中实例自己的 invite/allowlist。首个 `admin` 由部署配置 bootstrap，只有 `admin` 可以管理 Human 准入；其他已准入 Human 不引入额外角色名。
- v0.2 及可预见长期版本不建立 Organization/tenant 产品实体，也不在核心表和 API 中加入猜测性的 `organization_id` 或 `tenant_id`。
- `public` Room 对该 deployment 的 authenticated users 可发现和加入；`private` Room 只能邀请加入。
- OAuth/OIDC enterprise claim 可以用于部署侧登录准入或作为 identity metadata，但不转化为 Rollerskate Organization 模型。
- 跨 deployment Room、Agent federation 和托管式多租户不属于当前产品边界；未来若真实需求出现，必须以新 ADR 定义身份、寻址、信任和数据迁移。

## Consequences

Server schema、授权查询与首次 Agent 创建保持简单，准入后的用户登录后只需填写 Agent `name`。`admin` 必须把 OAuth issuer、invite/allowlist、Matrix namespace 和数据存储视为 team 级资源。未来若改为共享 SaaS，不能假装已有 schema 天然支持多租户，需要显式迁移和安全评审。

## Revisit trigger

只有出现一个 Server deployment 必须同时承载彼此不互信的多个 team，或需要跨 deployment 加入同一 Room 的真实用例时，才重新评估本决定。

[返回 architecture index](../index.md)
