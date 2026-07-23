# Rollerskate

![Rollerskate logo](assets/logo.png)

Rollerskate 是由中心 Server 与用户设备上的 Local Runtime 组成的 Agent proactive system。`v0.3.0` 将本地执行收敛为 offline-first canonical Event core：所有固定 ingress 先构造 Event，`Event.type` 只路由到一个 Handler，Result 再按可选 Destination 投递；同时提供 one-shot poll Subscription 与 loopback Console 审计。当前产品入口是 `scripts/rs` CLI 与 `scripts/rs start` 打开的本地 UI。

## Terminal product

每台电脑运行一个 Local Runtime，并只完成一次 Device login。推荐按 [CLI Quickstart](docs/runbook/quickstart.md) 使用可重复执行的单命令完成 Device、workspace、Agent、Room 和 loop 初始化：

```bash
export ROLLERSKATE_SERVER_URL=http://localhost:4100
scripts/rs device login
scripts/rs workspace set "$PWD/.rollerskate/agents"
```

同一个 Runtime 下可以继续添加多个 Codex Agent，不重复 Human OIDC 或 Device login：

```bash
scripts/rs workspace set "$PWD/.rollerskate/agents"
scripts/rs agent create alice --client codex
scripts/rs start
```

默认 Runtime 位于当前仓库的 `.rollerskate`；`--runtime` 只用于确实需要隔离另一个设备运行实例或测试参与端的场景，不是 Agent/Client 名。Room 创建、成员邀请、Agent binding、Human send、history、Attention policy、status、trace、pause/resume 和 recovery 都有 CLI 入口。

本地可在没有 Device、Room 或 Matrix 的情况下向已注册 Agent 发送 Event：

```bash
scripts/rs agent request alice "检查当前 workspace"
scripts/rs trace <event-id>
```

request 会先构造 `agent.request` Event，再由唯一 AgentHandler 处理；SQLite 与 Console 保存 Event → Execution → Result → Session → Delivery 审计链。

## 项目结构

- `local/`：已实现的设备侧 Runtime package。
- `server/`：Node.js/TypeScript BFF、企业 OIDC、Human/Device/Agent/Room 控制面、Matrix Application Service 与 MySQL 8 migration package。
- `packages/protocol/`：Server/Local 共享的运行时 schema 与 TypeScript 类型。
- `scripts/rs`：当前用户 CLI；`scripts/rollerskate` 保留为兼容入口。
- `docs/architecture/`：当前有效的系统边界、模块关系、不变量和 ADR。
- `docs/runbook/`：运行与恢复步骤。

Local 的 core 拥有 canonical Event、durable Agent execution 与唯一长期运行的 loop；Subscription 是随源码发布的第一方 Capability，用户 Plugin 只能填入受限 strategy slot。完整源码归属与依赖方向以 [Source map](docs/architecture/source-map.md) 为准，运行语义见 [Local Runtime architecture](docs/architecture/local-runtime.md)。

## 开发验证

```bash
npm install
npm run verify
```

首次使用一键开发环境时，将 `dev/.env.example` 复制为 `dev/.env`，填入正式企业 OIDC client，然后运行：

```bash
npm run dev:up
```

该命令先幂等生成并持久化开发 Matrix Application Service secrets，再构建 Rollerskate Server，并启动 MySQL 8.4、Synapse、migration 与 Server。空数据库上的第一个成功 OIDC 登录会原子认领 deployment admin；Local Runtime 继续在宿主机运行。Compose 只用于开发和验收，不代表生产部署方式。配置、健康检查和停止方式见 [Server foundation runbook](docs/runbook/server-foundation.md)。

## 文档入口

- [CLI Quickstart](docs/runbook/quickstart.md)
- [Current architecture](docs/architecture/index.md)
- [Source map](docs/architecture/source-map.md)
- [Poll Subscription runbook](docs/runbook/subscriptions.md)
