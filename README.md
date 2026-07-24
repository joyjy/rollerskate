# Rollerskate

![Rollerskate logo](assets/logo.png)

Rollerskate 是 Local-first Agent proactive system。`v0.3.1` 首次启动无需 Server、OIDC 或 Device enrollment：Runtime 自动建立全局 `~/.rollerskate/`、共享 LocalWorkspace、Owner Principal、唯一 `Local` Chat 与前台 loop。当前产品入口是 `scripts/rs start` 打开的本地 UI；Server/Matrix 路径保留为独立的可选远端控制面。

## Local product

每台电脑运行一个 Local Runtime。启动后在 Agents 页面填写短 handle 并选择 client，即可创建 generated Principal ID 并进入唯一的 `Chats / Local`：

```bash
scripts/rs start
```

也可以通过 CLI 管理 Local Agent：

```bash
scripts/rs agent create alice --client codex
scripts/rs agent rename alice helper
scripts/rs agent suspend helper
scripts/rs agent resume helper
```

Local Chat 的 Owner/system/Agent message 都是 immutable canonical Event。明确 `@agent` 会直接创建一次 dispatch；无 mention 时 loop 追加 durable 单选 card。Agent reply 直接成为 typed `chat.message`，每个 Agent 独立续接 current Session。默认 Runtime 是 `~/.rollerskate/`；`--runtime <absolute-path>` 用于显式隔离测试。

## 项目结构

- `local/`：已实现的设备侧 Runtime package。
- `server/`：Node.js/TypeScript BFF、企业 OIDC、Human/Device/Agent/Room 控制面、Matrix Application Service 与 MySQL 8 migration package。
- `packages/protocol/`：Server/Local 共享的运行时 schema 与 TypeScript 类型。
- `scripts/rs`：当前用户 CLI。
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
- [CLI Command Reference](docs/runbook/cli-reference.md)
- [Event Reference](docs/architecture/event-reference.md)
- [Current architecture](docs/architecture/index.md)
- [Source map](docs/architecture/source-map.md)
- [Poll Subscription runbook](docs/runbook/subscriptions.md)
