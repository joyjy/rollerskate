# Rollerskate

![Rollerskate logo](assets/logo.png)

Rollerskate 是 Local-first Agent proactive system。首次启动无需 Server、OIDC 或 Device enrollment：Runtime 自动建立全局 `~/.rollerskate/`、共享 LocalWorkspace、Owner Principal、唯一 `Local` Chat 与前台 loop。当前版本已提供 Subscription、Scheduled Task、Multi-Client Review、Free Chat、Runtime/Capability Console views 与 Notice Center；基础产品入口仍是 `scripts/rs start`。schema v43 不再保留旧 Server/Matrix Local binding，新的 Server Agent authentication、Topic/TransportBinding 与 cursor/session persistence 在 v0.4 重建。

## Local product

每台电脑运行一个 Local Runtime。启动后在 Agents 页面填写短 handle 并选择 client，即可创建 generated Principal ID 并进入唯一的 `Chats / Local`：

```bash
scripts/rs start
```

`start` 将 Console API 与内置 Vite 挂在同一个 loopback 地址；`local/ui/src/` 是产品运行源，Agent 保存 Vue、TypeScript 或 CSS 后，已打开页面通过 HMR 更新。Console production build 仍属于验证门禁，但静态 `local/ui/dist/` 不是默认产品入口。

也可以通过 CLI 管理 Local Agent：

```bash
scripts/rs agent create alice --client codex
scripts/rs agent create claude --client claude-code --launch-arg --model --launch-arg claude-sonnet-4-6
scripts/rs agent create kimi --client kimi-code
scripts/rs agent configure kimi --launch-arg --model --launch-arg kimi-code/kimi-for-coding
scripts/rs agent rename alice helper
scripts/rs agent suspend helper
scripts/rs agent resume helper
scripts/rs chat presence set helper --scope topic --mode snoozed --until 2030-07-25T18:00:00+08:00 --wake-keyword urgent
scripts/rs notice list
scripts/rs notice ack <notice-id>
```

Local Chat 的 Owner/system/Agent message 都是 immutable canonical Event。明确 `@agent` 只唤起目标 Agent；无 mention 时所有 available Agent 都能自主选择 reply 或 silent。Presence 属于 `Agent × (Global | Topic)`，不是 Topic 配置；Agent decision 与 Owner 的 `chat presence set` 都可更新。直接 mention、literal wake keyword 或到期触发下一次决策；Agent reply 继续成为 typed `chat.message`，每个 Agent 独立续接 current Session。CLI 可用 `scripts/rs chat post|history|status|presence` 与 `scripts/rs chat session new` 完成闭环。默认 Runtime 是 `~/.rollerskate/`；`--runtime <absolute-path>` 用于显式隔离测试。

### 从旧公开快照升级

从 v0.3.1 公开快照升级时，先备份原有 `~/.rollerskate/`，再用新的绝对路径（例如 `--runtime /absolute/path/to/rollerskate-v0.3.10`）验证当前版本。当前 schema v43 只直接迁移 v42，不支持把早期公开快照的 SQLite schema 原地升级到 v43；确认新 Runtime 可用前，不要覆盖或删除旧数据。

Scheduled Task 通过同一个前台 loop 主动创建 Agent work，不依赖 Server、系统 cron 或新 UI：

```bash
scripts/rs schedule create /absolute/path/to/schedule.json
scripts/rs schedule list
scripts/rs schedule runs <schedule-id>
```

完整 JSON、cron/timezone、misfire/overlap 与恢复方法见 [Scheduled Task runbook](docs/runbook/scheduled-tasks.md)。

Review 使用同一个 loop，让只读 Reviewer 与 workspace-write Implementer 按固定 MRSF/revision contract 完成有限返修：

```bash
scripts/rs review create /absolute/path/to/review.json --request-id acceptance-1
scripts/rs review trace <root-event-id>
```

完整配置、权限、sidecar 与恢复方法见 [Local Review runbook](docs/runbook/reviews.md)。

## 项目结构

- `local/`：已实现的设备侧 Runtime package。
- `server/`：Node.js/TypeScript BFF、企业 OIDC、Human/Device/Agent/Room 控制面、Matrix Application Service 与 MySQL 8 migration package。
- `packages/protocol/`：Server/Local 共享的运行时 schema 与 TypeScript 类型。
- `scripts/rs`：当前用户 CLI。
- `docs/architecture/`：当前有效的系统边界、模块关系、不变量和 ADR。
- `docs/runbook/`：运行与恢复步骤。

Local 的 core 拥有 canonical Event、durable Agent execution 与唯一长期运行的 loop；Subscription、Scheduled Task 与 Review 是随源码发布的第一方 Capability，用户 Plugin 只能填入受限 strategy slot。完整源码归属与依赖方向以 [Source map](docs/architecture/source-map.md) 为准，运行语义见 [Local Runtime architecture](docs/architecture/local-runtime.md)。

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
- [Current architecture](docs/architecture/index.md)
- [Event Reference](docs/architecture/event-reference.md)
- [Source map](docs/architecture/source-map.md)
- [Poll Subscription runbook](docs/runbook/subscriptions.md)
