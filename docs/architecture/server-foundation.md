---
type: Architecture
title: Rollerskate Server Foundation
description: Server package、OIDC Human admission、Device/Agent enrollment、Room control plane、MySQL migration 与 credential secret 的当前实现边界。
tags: [rollerskate, server, protocol, mysql, credential]
timestamp: 2026-07-19
---

# Server Foundation

[返回 architecture index](./index.md)

## Package boundary

- `server/` 是独立的 Node.js 24、TypeScript 7 package。BFF 为 CLI Device login 使用 discovery 声明的 OAuth Device Authorization Grant，为真正的 Web session 保留 OIDC Authorization Code + PKCE；同时提供 deployment allowlist、首次登录 admin claim、BFF session、Device/Agent identity routes，以及 Room control、Matrix transaction、Agent head/range/stream/send routes。
- `server/src/api/` 处理 HTTP 入站协议，`application/` 编排跨模块 Room 用例，`modules/` 持有 `trust`、`device`、`agent`、`event` 业务能力，`adapter/` 实现 Matrix、OIDC 和 persistence port，`bootstrap/` 只负责配置与依赖装配。核心层不反向依赖 adapter 实现。
- `packages/protocol/` 是 Server/Local 网络协议的 source of truth。Zod schema 同时提供运行时校验与推导 TypeScript 类型；协议 package 不依赖 HTTP、Matrix、MySQL 或 SQLite adapter。
- `local/` 与 `server/` 都直接依赖共享协议，但分别拥有自己的持久化和 migration 生命周期。Local 继续使用 Node SQLite；Server 首版只验证 MySQL 8。

## Protocol boundary

共享对象包括 Human、Device、Agent、Placement、AgentRoomBinding、Room Event projection、pairing transaction、enrollment grant、credential metadata 与 Attention result。所有网络输入使用 versioned Event envelope；Matrix relation、upstream event ID 等 transport fact 只能放在 `adapter.metadata`，不能进入 Core Chat 语义。

`CredentialMetadata` 明确拒绝额外 secret 字段。Server 对 Device 和 Agent credential 都只保存带随机 salt 的 scrypt hash。Local 将 secret 原子写入独立 mode-0600 文件，SQLite 只保存 identity、placement、workspace 摘要和 credential ID；status 与 restart 重新向 Server 验证。

Agent create 必须由 active Device credential 发起，owner/operator 从该 Device 绑定的 active Human 推导。Server 在一个事务内创建或恢复 Agent、唯一 pending/active Home placement 和绑定目标 Device 的短期 enrollment grant。Local 生成 verifier 并在首次网络请求前持久化；同一 verifier 的重复 create/redeem 用于收敛 crash gap，返回同一 Agent 和 credential ID，不生成第二个 secret。Agent credential 同时绑定 `agent_id` 与 `placement_id`；placement 不再 active 时旧 credential 不能认证，Alice credential 也不能通过 Bob 的 principal endpoint。

OIDC identity key 固定为 `(issuer, subject)`。CLI 创建 Device pairing 时，Server 从 discovery 读取 `device_authorization_endpoint`，持有 `device_code` 并按 Provider 返回的 interval 轮询 token endpoint；CLI 只接收 verification URI/user code 和 Rollerskate pairing 状态，不接触企业 OIDC token。`authorization_endpoint`、callback、state、nonce 与 PKCE verifier 只服务 Web session。空 deployment 的第一个成功 OIDC 登录在 repository 事务内锁定 singleton bootstrap row、建立 Human 并认领 admin；后续 identity 必须先进入 allowlist，两个并发首次登录不能同时成为 admin。被撤销 Human 不会因再次 OIDC 登录自动恢复。

## Database boundary

Server migration 位于 `server/migrations/`，由独立 CLI 读取 `ROLLERSKATE_DATABASE_URL` 执行。migration 建立 identity、placement、Room/membership/binding/Event projection、Matrix principal/transaction、pairing/enrollment、credential metadata、OIDC Web transaction、Device Authorization polling state、allowlist、BFF session 与 deployment bootstrap singleton 表；ID 由应用生成，不依赖 auto-increment、PostgreSQL JSONB、partial index、`RETURNING` 或数据库事件。

首版支持目标是 MySQL 8，而不是未经验证的多数据库兼容。SQL 保持低方言依赖以降低未来迁移成本，但 DDL、锁、隔离级别和 migration 必须对每个新增数据库单独验证，不能把“标准 SQL”解释为自动兼容。

Migration CLI 不承担多实例并发协调；部署流程必须保证同一数据库只有一个 migration owner。业务进程不得在启动时隐式执行 migration。
