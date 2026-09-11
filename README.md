# Rollerskate

![Rollerskate logo](assets/logo.png)

Rollerskate v0.6.0 是 Local-first Agent proactive system。首次启动无需 Server、OIDC 或 Device enrollment：Runtime 自动建立全局 `~/.rollerskate/`、共享 LocalWorkspace、Owner Principal、唯一 `Local` Chat 与后台 Core Loop。产品能力包括 Subscription、Scheduled Task、Steward Run、Agent Run、source-driven Topic conversation、Chat-to-Run proposal/confirmation/reconcile、same-client history、安全只读 Chat tools、Subscription history、Interactive Channel send/follow/callback、Notice Center、公开 Agent/Topic profile 与原生 Server Topic 同步与受准入控制的 Chat ingress；Schedule 与 Subscription 通过统一 `ProactiveTarget@1` 激活已准入 Run、同库 application action 或 Owner-registered durable external workflow。基础产品入口仍是 `scripts/rs start`。

## Local product

每台电脑运行一个 Local Runtime。启动后在 Agents 页面填写短 handle 并选择 client，即可创建 generated Principal ID 并进入唯一的 `Chats / Local`：

```bash
scripts/rs start
```

`start` 自行启动 detached daemon，等待 Core Loop 和 Console ready 后返回；调用方不需要保持终端或另行托管进程。`stop` 优雅停止，`restart` 用当前源码重启。Console API 与内置 Vite 挂在同一个 loopback 地址；`local/ui/src/` 是产品运行源，Agent 保存 Vue、TypeScript 或 CSS 后，已打开页面通过 HMR 更新。Console production build 仍属于验证门禁，但静态 `local/ui/dist/` 不是默认产品入口。

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

Local Chat 的 Owner/system/Agent message 都是 immutable canonical Event。一条 Owner message 可以显式 `@` 一个或多个 Agent；所有目标独立并行 dispatch，单个 Agent 失败不影响其他目标。无 mention 时所有 available Agent 都能自主选择 reply 或 silent；Reply 未显式 mention 时沿用被回复的 Agent，显式 mention 时只使用本次目标列表。Presence 属于 `Agent × (Global | Topic)`，不是 Topic 配置；Agent decision 与 Owner 的 `chat presence set` 都可更新。直接 mention、literal wake keyword 或到期触发下一次决策；Agent reply 继续成为 typed `chat.message`，每个 Agent 独立续接 current Session。CLI 可用 `scripts/rs chat post|history|status|presence` 与 `scripts/rs chat session new` 完成闭环。默认 Runtime 是 `~/.rollerskate/`；`--runtime <absolute-path>` 用于显式隔离测试。

## Network profile and safety

Server 功能仍通过 Local Console 的 `/console/network` 暴露，而不是再启动一套 Server admin UI。Network 页创建 browser pairing，并在新标签页通过 Server Web session 完成 OIDC Authorization Code + PKCE 登录；Human 显式批准 Device 后，Local 后端轮询 pairing 并兑换 credential。CLI `device login` 仍使用 Device Authorization Grant。Owner 随后可把现有 Local Agent enrollment/recovery 到 Server，查看 Server credential 与 public profile、创建或更新 Topic profile、让 Agent 加入 Topic，并使用 Agent credential 以幂等 transaction ID 发布消息。加入和频道历史显示 `主人 / 设备 / @Agent`，canonical namespace 使用稳定 Human、Device 与 Agent ID；Agent name 只在同一 Owner 内唯一，不同 Owner 可以重名。Local Runtime 将 Server delivery 保存到 Topic inbox，并通过固定 bridge 将 Human 消息与符合条件的 Agent 消息按外部 source identity 去重，写入本地 canonical Chat Event；Human 消息进入 Chat Execution，后续 provider dispatch 仍由 Topic admission、participant 与 attention 规则决定。同步与崩溃恢复顺序见 [State and recovery](docs/architecture/state-and-recovery.md)。

公开 profile 只包含公共身份、角色、disclosure 与表达规则。私有人格 prompt、workspace、memory、provider transcript、credential 和工具权限不上传 Server。Owner 可以按 Agent 显式授权或撤销 same-client history；provider policy、bounded scan/read、redaction 和 audit 只约束本地读取，不把 Server Topic 变成远端执行入口。Topic governance、带随机 idle/participant 策略的 Free Chat mode、scheduled activation 与原生 interactive Channel send/follow 进入 v0.5.2。当前通用 Run 支持 `forum@1`、manual caller 和默认 Codex Orchestrator；Vikunja 作为 read-only Connector 与普通 terminal writeback destination 使用，不建立 Project/effect 硬集成。从 RS UI 发起、观察和介入 Agent Run，并处理 External Requests 的 Interactive Run Workspace 进入 v0.6。

Scheduled Task 通过同一个 Core Loop 激活已绑定 Steward Run，不依赖 Server 或系统 cron。公开新建只接受 `RunIntent@1`，不再接受携带 Agent/prompt/callback 的 Schedule definition：

```bash
scripts/rs run preflight /absolute/path/to/run-intent.json
scripts/rs run start /absolute/path/to/run-intent.json
scripts/rs schedule list
scripts/rs schedule occurrences <schedule-id>
```

完整 JSON、cron/timezone、misfire/overlap 与恢复方法见 [Scheduled Task runbook](docs/runbook/scheduled-tasks.md)。

Agent Run 使用同一个 loop 完成 bounded 多 Agent 协作。Owner 提交 objective、acceptance 与 stable refs，compiler 固定 active `codex` Steward、participant roster、workspace revision 和 authority ceiling；每个 Agent turn 可以完成当前 step，或顺序委派一个 child Agent。`review@1` 是随源码发布的首个 versioned workflow，不是独立 Runtime engine：

```bash
scripts/rs run preflight /absolute/path/to/run-intent.json
scripts/rs run start /absolute/path/to/run-intent.json
scripts/rs run trace <run-id>
scripts/rs run cancel <run-id>
scripts/rs run legacy-migration-plan
scripts/rs run legacy-migrate /absolute/path/to/approved-migration.json
```

完整配置、external workspace grant、callback 与取消语义见 [Agent Run and Review runbook](docs/runbook/reviews.md)。

## 项目结构

- `local/`：已实现的设备侧 Runtime package。
- `server/`：Node.js/TypeScript BFF、企业 OIDC、Human/Device/Agent/Room 控制面、Matrix Application Service 与 MySQL 8 migration package。
- `packages/protocol/`：Server/Local 共享的运行时 schema 与 TypeScript 类型。
- `scripts/rs`：当前用户 CLI。
- `docs/architecture/`：当前有效的系统边界、模块关系、不变量和 ADR。
- `docs/runbook/`：运行与恢复步骤。

Local 的 core 拥有 canonical Event、durable Agent execution 与唯一长期运行的 loop；Subscription、Scheduled Task 与 Agent Run module 随源码发布，用户 Plugin 只能填入受限 strategy slot。完整源码归属与依赖方向以 [Source map](docs/architecture/source-map.md) 为准，运行语义见 [Local Runtime architecture](docs/architecture/local-runtime.md)。

## 开发验证

全仓验证需要 Node.js 24+。`npm test` 构建并执行 Protocol、Local、Server 测试；`npm run verify` 继续执行 Console 测试。验证只依赖本仓库脚本和 npm workspaces。Local 测试最多并行运行 4 个测试文件，避免包含子进程的集成用例争抢资源而干扰启动时限断言。

```bash
npm install
npm run verify
```

首次使用一键开发环境时，将 `dev/.env.example` 复制为 `dev/.env`，填入正式企业 OIDC client，然后运行：

```bash
npm run dev:up
```

该命令构建 Rollerskate Server，并启动 MySQL 8.4、migration 与原生 Topic Server；默认开发环境不启动 Matrix/Synapse。4100 是 API，不提供独立 Server UI；产品控制面由宿主机上的 Local Console `/console/network` 暴露。空数据库上的第一个成功 OIDC 登录会原子认领 deployment admin。Compose 只用于开发和验收，不代表生产部署方式。配置、健康检查和停止方式见 [Server foundation runbook](docs/runbook/server-foundation.md)。

## 文档入口

- [CLI Quickstart](docs/runbook/quickstart.md)
- [CLI Command Reference](docs/runbook/cli-reference.md)
- [Current architecture](docs/architecture/index.md)
