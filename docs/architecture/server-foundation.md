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

- `server/` 是独立的 Node.js 24、TypeScript 7 package。BFF 为 CLI Device login 使用 discovery 声明的 OAuth Device Authorization Grant；Local Console 通过 Server Web session 使用 OIDC Authorization Code + PKCE，浏览器以 GET 直接进入 Provider authorization endpoint，再由 Human 显式批准 Device pairing。Server 同时提供 deployment allowlist、首次登录 admin claim、BFF session、Device/Agent identity routes，以及 Room control、Matrix transaction、Agent head/range/stream/send routes。
- `server/src/api/` 处理 HTTP 入站协议，`application/` 编排跨模块 Room 用例，`modules/` 持有 `trust`、`device`、`agent`、`event`、`connector` 与 `work-request` 业务能力，`adapter/` 实现 Matrix、OIDC 和 persistence port，`bootstrap/` 只负责配置与依赖装配。核心层不反向依赖 adapter 实现。
- `packages/protocol/` 是 Server/Local 网络协议的 source of truth。Zod schema 同时提供运行时校验与推导 TypeScript 类型；协议 package 不依赖 HTTP、Matrix、MySQL 或 SQLite adapter。
- `local/` 与 `server/` 都直接依赖共享协议，但分别拥有自己的持久化和 migration 生命周期。Local 继续使用 Node SQLite；Server 首版只验证 MySQL 8。

## Protocol boundary

共享对象包括 Human、Device、Agent、Placement、AgentRoomBinding、Room Event projection、pairing transaction、enrollment grant、credential metadata、Attention result，以及 `IntegrationBinding@1`、`ExternalRef@1`、`Observation@1` 和 `AgentWorkRequest@1`。所有网络输入使用严格 Zod schema；Matrix relation、upstream event ID 等 transport fact 只能放在 `adapter.metadata`，不能进入 Core Chat 语义。Connector/work-request payload 使用独立 string/array/JSON 上限，credential 只能以 opaque reference 出现。

Integration HTTP surface 由 active Device credential 代表 Owner 调用。binding 固定 Connector identity/version、placement、endpoint、profile allowlist、external scope 与 opaque `credentialRef`，并用 revision CAS 更新 cursor/status；它不授予 caller 对 Local Agent、Run、workspace 或 provider mutation 的控制权。Server 没有 Project policy、Project participant 或 external effect API。

Agent work request 由 authenticated Human Device 或 Agent credential 创建。Server 只在目标 Agent 持有当前 Runtime route lease 时把新请求绑定到该 exact route；目标不可用时直接持久化 `target-unavailable`，不建立离线队列。Runtime 重启会获得新 route ID，旧 route 上尚未接受的请求不会补推；已经接受但尚未挂 Run receipt 的请求可由同一目标 Agent恢复。目标 decision、Run receipt 与 bounded public result 都使用 revision CAS 和内容幂等；requester 只能读取自己的共享 request/result、在接受前 withdraw，不能读取 Local trace 或控制目标 Run。

`CredentialMetadata` 明确拒绝额外 secret 字段。Server 对 Device 和 Agent credential 都只保存带随机 salt 的 scrypt hash。Local 将 secret 原子写入独立 mode-0600 文件，SQLite 只保存 identity、placement、workspace 摘要和 credential ID；status 与 restart 重新向 Server 验证。

Agent create 必须由 active Device credential 发起，owner/operator 从该 Device 绑定的 active Human 推导。Agent name 在同一 Owner 内唯一，不同 Owner 可以重名；Device name 与 Human display name 也不是身份键。跨 Owner、Device 与 Topic 的 canonical namespace 始终使用稳定 Human、Device 与 Agent ID，display name 和 device name 只作可读快照。Server 在一个事务内创建或恢复 Agent、唯一 pending/active Home placement 和绑定目标 Device 的短期 enrollment grant；同 Owner 从另一台 active Device 显式恢复同名 Agent 时保留 Agent ID、递增 placement generation，并撤销旧 enrollment grant 与旧 placement credential。Local 生成 verifier 并在首次网络请求前持久化；同一 verifier 的重复 create/redeem 用于收敛 crash gap，返回同一 Agent 和 credential ID，不生成第二个 secret。Agent credential 同时绑定 `agent_id` 与 `placement_id`；placement 不再 active 时旧 credential 不能认证，Alice credential 也不能通过 Bob 的 principal endpoint。

Topic publish 返回 publisher identity projection，至少包含 Agent ID/name、Owner Human ID/display name 与 placement Device ID。被动 inbox 可以显示可读的 `Owner / Device / @Agent`，同时依靠稳定 ID 消歧；该 projection 不授予 Owner、Device 或 Agent 新 authority，也不把 Topic delivery 变成本地 execution ingress。

OIDC identity key 固定为 `(issuer, subject)`。CLI 创建 Device pairing 时，Server 从 discovery 读取 `device_authorization_endpoint`，持有 `device_code` 并按 Provider 返回的 interval 轮询 token endpoint；CLI 只接收 verification URI/user code 和 Rollerskate pairing 状态，不接触企业 OIDC token。Local Console 创建 browser pairing 后打开 Server approval URL；Server 通过 `authorization_endpoint`、callback、state、nonce 与 PKCE verifier 建立 Human Web session，Human 确认后批准 pairing，Local 后端继续轮询并兑换 Device credential。空 deployment 的第一个成功 OIDC 登录在 repository 事务内锁定 singleton bootstrap row、建立 Human 并认领 admin；后续 identity 必须先进入 allowlist，两个并发首次登录不能同时成为 admin。被撤销 Human 不会因再次 OIDC 登录自动恢复。

## Database boundary

Server migration 位于 `server/migrations/`，由独立 CLI 读取 `ROLLERSKATE_DATABASE_URL` 执行。migration 建立 identity、placement、Room/membership/binding/Event projection、Matrix principal/transaction、pairing/enrollment、credential metadata、OIDC Web transaction、Device Authorization polling state、allowlist、BFF session、deployment bootstrap singleton、`integration_bindings` 与 `agent_work_requests`。0011 曾创建的 `project_bindings`、`external_effects` 目前仅作为 unreleased schema tombstone 保留：应用没有 reader/writer/API，迁移不删表或用户数据。work request 表拥有共享 request lifecycle、requester idempotency、exact online route binding 与 target/result receipt。ID 由应用生成，不依赖 auto-increment、PostgreSQL JSONB、partial index、`RETURNING` 或数据库事件。

首版支持目标是 MySQL 8，而不是未经验证的多数据库兼容。SQL 保持低方言依赖以降低未来迁移成本，但 DDL、锁、隔离级别和 migration 必须对每个新增数据库单独验证，不能把“标准 SQL”解释为自动兼容。

Migration CLI 不承担多实例并发协调；部署流程必须保证同一数据库只有一个 migration owner。业务进程不得在启动时隐式执行 migration。
