---
type: Runbook
title: Rollerskate Server Foundation Runbook
description: 安装、配置并启动 Phase 1–3 Server，执行 migration、Matrix Application Service、Local Device login 和 Agent enrollment。
tags: [rollerskate, server, mysql, migration, runbook]
timestamp: 2026-07-19
---

# Server Foundation Runbook

## 安装与验证

```bash
npm install
npm run verify
```

## 一键开发环境

开发与验收使用 `dev/compose.yaml` 启动 MySQL 8.4、Synapse、Server migration 和 Rollerskate Server。它不包含本地 OIDC Provider，也不代表生产部署拓扑；Server 直接接入正式企业 OIDC，Local Runtime 与 Agent CLI 继续运行在宿主机。

首次启动先准备未受 Git 管理的真实配置：

```bash
cp dev/.env.example dev/.env
```

在 `dev/.env` 中填写正式 OIDC discovery URL、client ID 与可选 client secret。CLI Device login 从 discovery 读取 `device_authorization_endpoint`，不使用 callback；真正的 Web session 保留 Authorization Code + PKCE，如果 provider 要求后端 POST 初始化 Web 授权，再设置 `ROLLERSKATE_OIDC_AUTHORIZATION_REQUEST_METHOD=post`。只有启用 Web 登录时才需要注册 `http://localhost:4100/auth/callback`；如果调整 `ROLLERSKATE_DEV_SERVER_PORT`，Web callback 端口必须同步调整。

随后一条命令构建并启动完整 Server 依赖：

```bash
npm run dev:up
curl http://localhost:4100/healthz
curl http://localhost:4200/_matrix/client/versions
```

Matrix 健康检查中的宿主机端口应与 `ROLLERSKATE_DEV_MATRIX_PORT` 一致；上例使用模板默认值 4200。`npm run dev:up` 会先调用 `npm run dev:init`，在 Git 忽略的 `dev/secrets/` 下生成或复用 mode-0600 的 AS/HS token。Compose 通过文件 secret 将同一对 token 提供给 Synapse 与 Server，等待 MySQL 健康、执行幂等 migration、生成 Synapse 配置和 Application Service registration，再启动 Server。空数据库上的第一个成功 OIDC 登录会在数据库事务内认领 deployment admin，后续 identity 必须先进入 allowlist。`npm run dev:down` 停止容器但保留 MySQL、Synapse named volume 与开发 secrets；只有明确需要清空开发数据时才手动执行 `docker compose --env-file dev/.env -f dev/compose.yaml down --volumes`。

## 启动 Server

```bash
ROLLERSKATE_SERVER_HOST=127.0.0.1 \
ROLLERSKATE_SERVER_PORT=4100 \
ROLLERSKATE_PUBLIC_URL=http://127.0.0.1:4100 \
ROLLERSKATE_DATABASE_URL='mysql://user:password@127.0.0.1:3306/rollerskate' \
ROLLERSKATE_OIDC_ISSUER=https://identity.example.com \
ROLLERSKATE_OIDC_CLIENT_ID=rollerskate \
ROLLERSKATE_OIDC_CLIENT_SECRET='<secret>' \
ROLLERSKATE_MATRIX_HOMESERVER_URL=https://matrix.example.com \
ROLLERSKATE_MATRIX_SERVER_NAME=matrix.example.com \
ROLLERSKATE_MATRIX_AS_TOKEN='<as-token>' \
ROLLERSKATE_MATRIX_HS_TOKEN='<hs-token>' \
npm --prefix server start
curl http://127.0.0.1:4100/healthz
```

CLI Device login 要求 discovery 同时声明 `device_authorization_endpoint` 与 `urn:ietf:params:oauth:grant-type:device_code`。Web 登录才要求 OIDC provider 注册 `${ROLLERSKATE_PUBLIC_URL}/auth/callback`。生产环境的 public URL 与 OIDC endpoint 必须使用 HTTPS；HTTP 只允许 localhost 开发。空数据库上的第一个成功 OIDC 登录会认领 deployment admin；该认领由数据库 singleton row 串行化，不能产生两个首次管理员。

Matrix homeserver 必须注册一个指向 `${ROLLERSKATE_PUBLIC_URL}` 的 Application Service，并使用与 Server 环境完全相同的 `as_token`、`hs_token`。namespace 至少独占 Server 生成的 `@rs_h_<32 hex>:<server-name>` 与 `@rs_a_<32 hex>:<server-name>` virtual user；homeserver 必须能访问 `PUT /_matrix/app/v1/transactions/:txnId`。token 只能放在 Server secret 配置，不得写入浏览器、本地 Runtime 配置、URL 或日志。

## 执行 Server migration

先创建空的 MySQL 8 database，再由单一 migration owner 执行：

```bash
ROLLERSKATE_DATABASE_URL='mysql://user:password@127.0.0.1:3306/rollerskate' npm --prefix server run migrate
```

命令输出只包含 migration version，不打印 database URL 或 credential。重复执行应返回空的 `applied` 列表。

## 验证 Room API

Human Room 写操作使用 OIDC 登录后的 `rs_session` HttpOnly cookie。Agent Runtime 使用自己的 Agent bearer credential：

```text
POST   /api/rooms
GET    /api/rooms
POST   /api/rooms/:roomId/join
POST   /api/rooms/:roomId/members
POST   /api/rooms/:roomId/agents
PATCH  /api/rooms/:roomId/agents/:agentId
DELETE /api/rooms/:roomId/agents/:agentId
GET    /api/agent-principals/:agentId/rooms/:roomId/head
GET    /api/agent-principals/:agentId/rooms/:roomId/events?after=<cursor>&through=<head>&limit=50
GET    /api/agent-principals/:agentId/rooms/:roomId/stream
POST   /api/agent-principals/:agentId/rooms/:roomId/messages
```

恢复时先读取 `head=H`，再固定 `through=H` 分页；SSE 只包含连接后的在线 Event，不回放离线 gap。Matrix membership 不能替代 active `AgentRoomBinding`。

隔离环境可在 Server build 后运行真实 correlation smoke；该命令会执行 migration、创建临时 Human/Device/Agent/private Room、通过 Agent virtual user 发送消息，并等待 Synapse transaction callback 后从 Server range API 读回同一个 event ID：

```bash
ROLLERSKATE_DATABASE_URL='mysql://user:password@127.0.0.1:3306/rollerskate' \
ROLLERSKATE_MATRIX_HOMESERVER_URL=http://127.0.0.1:8008 \
ROLLERSKATE_MATRIX_SERVER_NAME=rollerskate.test \
ROLLERSKATE_MATRIX_AS_TOKEN='<as-token>' \
ROLLERSKATE_MATRIX_HS_TOKEN='<hs-token>' \
ROLLERSKATE_SERVER_PORT=13000 \
npm --prefix server run smoke:matrix-room
```

仅在明确隔离的 Matrix namespace/Room 执行该 smoke；它会产生真实 virtual users、Room 与 message。

## 执行 Local migration

Local migration 继续操作设备侧 SQLite，与 Server migration 完全独立：

```bash
npm --prefix local run migrate -- /absolute/path/to/runtime.db
```

## 配对 Local Runtime

```bash
scripts/rs device login
scripts/rs device status
scripts/rs device logout
```

`device login` 不接收 Server、Device name、Client 或 Agent 参数，只使用 `ROLLERSKATE_SERVER_URL` 或当前 Runtime 已保存的 Server；未配置时直接报错。它会打印 Provider 的 verification URI/user code，并按 discovery 返回的 interval 轮询 Rollerskate Server；设备显示名自动取本机 hostname。企业 `device_code`、OIDC token 与最终 Device credential 都不会出现在命令参数或日志中。credential 保存在 `.rollerskate/device-credential.json`，必须是普通 mode-0600 文件；SQLite 只保存元数据。`device logout` 在 Server revoke 成功后删除本地 credential；网络失败时保留文件，避免只做本地假退出。

## Legacy Agent enrollment 边界

v0.3.1 的 `agent` namespace 已归属 Local Runtime；`agent create` 的 `--client` 只选择本地 adapter，不执行 Server Agent enrollment。`workspace set` 仍保留为 legacy Server workspace 配置入口，但不是 Local-first 主路径。

当前全部命令和 Local/Server 分区见 [CLI Command Reference](./cli-reference.md)。
