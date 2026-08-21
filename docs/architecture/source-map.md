---
type: Architecture
title: Rollerskate Source Map
description: Rollerskate monorepo 的源码归属、共享契约、生成关系、文档层与验证入口。
tags: [rollerskate, architecture, source-map, ownership]
---

# Rollerskate Source Map

[返回 architecture index](./index.md)

本页是仓库 source roots 与 ownership 的唯一事实源。它描述稳定目录，不枚举普通源码文件，也不保存实施计划或历史。

## Directory Tree

```text
rollerskate/
├── packages/
│   └── protocol/
│       ├── src/                  # Local / Server 网络 contract
│       └── test/                 # protocol 公共边界验证
├── local/
│   ├── src/
│   │   ├── core/                 # canonical Event、execution kernel、唯一 loop
│   │   ├── application/          # 按业务域组织的 control、query 与 application module
│   │   ├── modules/              # Local 产品模型与纯状态策略
│   │   ├── capabilities/         # 随源码发布的第一方能力
│   │   ├── integrations/         # Agent、Matrix、Server 与外部 provider 适配
│   │   ├── infrastructure/       # SQLite/file persistence 与运行资源加载
│   │   ├── entrypoints/          # CLI 与 loopback HTTP 转换
│   │   └── bootstrap/            # 固定 runtime composition 与 migration
│   ├── resources/                # 随 build 发布的 prompt 与 versioned workflow
│   ├── scripts/                  # Local package build helper
│   ├── ui/src/                   # 由 Local product 内置 Vite 实时提供的 Vue Console 源码
│   └── test/                     # Local Runtime 公共边界验证
├── server/
│   ├── src/                      # 远端 control plane、Matrix AS 与 BFF
│   └── test/                     # Server 公共边界验证
├── examples/
│   ├── plugins/                  # 受限 strategy slot 示例
│   ├── probes/                   # allowlist command probe 示例
│   └── commands/                 # 外部命令与 completion receipt wrapper 示例
├── scripts/                      # repo launch、build 与验证 helper
├── dev/                          # 本地服务编排与开发 secret 初始化
├── assets/                       # 人类入口视觉资产
└── docs/
    ├── architecture/             # 当前架构、ownership 与 ADR
    ├── plan/                     # 尚未完成验收的 release plans
    ├── runbook/                  # 安装、运行与故障处理
    └── verification/             # 版本验收范围与外部证据
```

## Boundary Notes

- 顶层依赖方向是 `protocol <- local`、`protocol <- server`；Local 与 Server 不直接相互导入，也不把各自内部状态放进 protocol。
- `core/` 拥有唯一长期运行的 loop；`capabilities/` 和 `integrations/` 提供行为与适配，`bootstrap/` 只做固定装配，三者都不能建立第二个 loop。
- 一个 application vertical 以 `control.ts`、`query.ts` 为公共边界，纯 transition policy 放入 `modules/<domain>/state-machine.ts`，SQLite/file 细节放入 `infrastructure/`，CLI/HTTP/UI 只做转换。源码内第一方 vertical 在各 composition boundary 通过一条显式 manifest registration 接入；不依赖运行时扫描任意源码文件，也不把业务分支塞进 core 或 Agent adapter。
- `entrypoints/` 只把 CLI/HTTP 转成 application control/query，并在同一 loopback HTTP server 上挂载 Vite middleware；`local/ui/src/` 是 Console 产品运行源，只走 loopback API，两者都不直接访问 store。
- `examples/plugins/` 只能实现 Capability 预留的沙箱 strategy slot，不能注册 Capability、Event、Route、Handler 或 loop；`examples/probes/` 和 `examples/commands/` 只演示 host-owned probe 与外部进程 receipt 边界，不属于 Runtime 产品源码。
- `scripts/`、`dev/` 和 `assets/` 不拥有产品行为；`dev/secrets/` 是 ignored 本地状态。

## Architecture And Validation

- `packages/protocol/`：[System topology](./system-topology.md)、[Event and Handler flow](./event-and-chat-flow.md)；`npm run verify -w @rollerskate/protocol`。
- `local/src/` 与 `local/ui/src/`：[Local Runtime](./local-runtime.md)、[State and recovery](./state-and-recovery.md)、[Subscription](./poll-subscription.md)、[Local Steward And Review Workflow](./local-review.md)；`npm run verify -w @rollerskate/local`、`npm --prefix local/ui test`、`npm --prefix local/ui run type-check`、`npm --prefix local/ui run build`。
- `server/src/`：[Server foundation](./server-foundation.md)、[Room control plane](./room-control-plane.md)；`npm run verify -w @rollerskate/server`。
- `examples/`：[ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)、[Subscription](./poll-subscription.md)；随 Local 验证。
- 全仓编排与 helper：[Architecture index](./index.md)、[State and recovery](./state-and-recovery.md)；`npm run verify`、`npm run dev:init`。

## Shared Contracts

- `packages/protocol/src/index.ts`：Local/Server 网络 contract 的唯一公共入口；它只聚合 `shared.ts`、`identity.ts`、`room.ts`、`topic.ts`、`connector.ts` 与 `work-request.ts` 六个 domain owner，不直接定义 contract。
- `packages/protocol/src/connector.ts` 的 `IntegrationBinding@1`、`ExternalRef@1` 与 `Observation@1`：Connector 读取与观察的严格 bounded contract；`Connector@1` 只暴露 typed `describe/observe/read` request/result，不开放 generic provider call 或 mutation；credential 只跨边界传 opaque `credentialRef`，不传 secret value。
- `packages/protocol/src/work-request.ts` 的 `AgentWorkRequest@1`、create/decision/withdraw/Run/result 与 route lease schema：跨 owner 工作请求、在线精确路由、target admission 和 bounded public result 的严格 contract；不携带 provider transcript、Local workspace 或 remote stop capability。
- `local/src/core/event/model.ts`：Local canonical Event 与本地 Event ID 的事实源。
- `local/src/modules/foundation/model.ts`：LocalDevice、LocalWorkspace、Principal、LocalAgent 与 handle policy 的事实源；`local/src/infrastructure/sqlite/foundation-store.ts` 负责 SQLite persistence 与 bootstrap。
- `local/src/modules/topic/governance.ts`、`local/src/application/topic/governance-control.ts`、`governance-query.ts` 与 `admission.ts`：`TopicGovernance`、participant roster、conversation policy/themes、revision、`TopicGovernanceControlReceipt@1`、默认 materialization、统一 Chat admission 与 claim-time recheck 的事实源；`local/src/infrastructure/sqlite/topic-governance-store.ts` 只负责同库 CAS persistence。
- `local/src/modules/topic/free-chat.ts`、`local/src/application/topic/free-chat-{control,query,runtime}.ts`：Free Chat mode、确定性 cycle sample、恢复/停止语义与 CLI/API 共用 application contract 的事实源；`local/src/infrastructure/sqlite/free-chat-mode-store.ts` 只负责 current mode 和 immutable receipt 的 CAS persistence。
- `local/src/modules/topic/schedule.ts`、`local/src/application/topic/schedule-{control,query,runtime}.ts`：`TopicActivationSchedule`、once/cron occurrence、candidate/intent policy、CAS control、bounded skip 与 canonical Chat activation admission 的事实源；`local/src/infrastructure/sqlite/topic-activation-schedule-store.ts` 只负责 current schedule 和 occurrence receipt 的同库 persistence。它与 `capabilities/scheduled-task` 的 arbitrary prompt/callback contract 分离。
- `local/src/modules/channel/`、`local/src/application/channel/` 与 `local/src/infrastructure/sqlite/channel-store.ts`：Interactive Channel binding、Agent/allowlist/expiry authority、idempotent send receipt、cursor/follow 与 exact idle Session callback 的事实源；Local send 复用 Chat admission，Server send 复用 Agent credential/Topic membership，不建立 Core channel model。
- `local/src/modules/agent/client-profile.ts`：受支持 Agent client、adapter ID、per-Agent launch args schema 与 reserved-argument policy 的事实源。
- `local/src/integrations/agent/runner/`：ACP-shaped provider-neutral turn request/receipt、共享 process lifecycle 与 wire transport 的事实源。`acp.ts` 使用官方 ACP SDK，拥有 initialize、new/resume、mode/config、permission、prompt terminal、bounded update projection 与 watchdog；`pi-rpc.ts` 拥有 Pi RPC command/event、exact Session state、`agent_settled` terminal 与 oversized-record discard；`codex-app-server.ts` 拥有 initialize、Thread start/resume、Turn terminal、delta/item/usage 投影与 fail-closed server request。`local/src/integrations/agent/*.ts` 与 `local/resources/agents/` 只拥有 Runtime Event prompt、workspace grant 到 provider policy、Chat/Run assistant 选择、Pi `--tools`/history extension 和 bundled prompt policy。
- `local/src/core/chat/`：`ChatDecision@1`、scoped presence 与纯 attention planning 的事实源。
- `local/src/application/chat/`、`local/src/entrypoints/mcp/chat-history.ts` 与 `local/resources/prompts/chat/`：Chat control/handler 编排、稳定 prompt resource ID、context rendering、current-Topic `read_chat_history` tool 的 bounded cursor contract 与 Chat 行为资源的事实源；`bootstrap/runtime.ts` 只按 client capability 装配 MCP server 或 Pi extension，非 Codex/Kimi/Pi client 保留 request continuation fallback。
- `local/src/application/runtime/query.ts`、`workload-query.ts` 与 `failure-query.ts`：Runtime process/control availability、Loop workload 与 bounded Failure projection 的共同 CLI/Console 语义出口。
- `local/src/application/runtime/progress.ts`、`~/.rollerskate/runs/<runId>/progress.json` 与 `~/.rollerskate/progress.json`：从 `agent_runs` authority 重建的 per-Run 进展投影及发现索引；唯一 loop 原子覆盖，每个 Run 独立固定路径，不复制 transcript 或 terminal summary。
- `local/src/application/event/query.ts`：Events list/trace 的共同 CLI/Console 语义出口。
- `local/src/infrastructure/sqlite/chat-store.ts`：唯一 `Local` Chat 的 SQLite projection、Owner message admission 与 current Session pointer。
- `local/src/core/loop.ts`：唯一长期运行 loop、phase 调度和顶层异常隔离的事实源。
- `local/src/core/runtime/model.ts`：Local Route、durable execution、generic result-contract routing context 与 completion callback primitive 的事实源；Core 不拥有具体 Agent result schema。
- `local/src/core/runtime/store.ts` 与 `local/src/core/runtime/store/`：RuntimeStore 稳定公共入口、跨 Event/Execution/Session/Chat/Delivery 的同库事务协调，以及内部 Event、Chat、Delivery、query、audit、codec 分工；内部组件共享同一个 `DatabaseSync`，不能各自打开连接或把跨 owner transaction 拆开。
- `local/src/capabilities/subscription/plugin-contract.ts`：用户 Subscription Plugin 唯一允许实现的 strategy slot contract。
- `local/src/capabilities/subscription/store.ts`：`SubscriptionDefinition@3` one-shot durable lifecycle；Continuous Subscription 使用独立 parent store。
- `local/src/capabilities/subscription/continuous-model.ts`、`continuous-store.ts` 与 `continuous-runtime.ts`：Continuous Subscription 的长期 poll、stable observation identity、pending callback group 与 receipt 后 checkpoint lifecycle。
- `local/src/modules/callback/`、`local/src/application/callback/` 与 `local/src/infrastructure/callback/`：one-shot/Continuous Subscription 与 Schedule 共用的 callback contract、application orchestration、host executor、durable store、occurrence 与 crash-unknown recovery；它们是按 layer 分布的共享运行组件，不构成独立 Capability，也不拥有具体 trigger parent 状态机。`infrastructure/callback/store.ts` 是三个第一方 owner 与唯一 `ProactiveCallbackRuntime` 共用的 callback persistence 入口，SQLite 只是其实现细节。
- `local/src/integrations/host-command.ts` 与 `local/src/infrastructure/callback/host-kernel.ts`：外部 adapter 使用的 bounded、无 shell host-command port，以及唯一持有 `execFile` 的 host execution owner；外部业务 integration 只解释自己的 transport 和领域输入，不直接拥有进程执行。
- `local/src/integrations/server/pairing-client.ts`、`device-client.ts` 与 `agent-client.ts`：匿名 Pairing、Human/Device control 与 Agent publish/principal 三种网络 authority 的窄 client；仅共享 bounded HTTP transport。
- `local/src/integrations/vikunja/`：`playground@1` 的 read-only Vikunja `Connector@1` adapter、provider-neutral bounded snapshot、mode-0600 observation ledger，以及普通 `vikunja-task` Destination adapter 的事实源；只接受调用时提供的 token callback，不保存 `credentialRef` 或 secret value，也不拥有 Project policy、Run lifecycle 或第二个 loop。历史 effect ledger entry 只作为 inert tombstone 原样保留。真实隔离验证入口是 `npm --prefix local run smoke:vikunja`。
- `local/src/application/network/`、`topic/` 与 `activity/`：Local Console 的 Network safety projection、Server Topic/profile control、bounded/redacted Local activity access，以及显式授权的 same-client history authority；history grant/audit 由 Runtime 私有文件拥有，正文不复制进 SQLite 或 Server。Codex 的 `integrations/activity/codex-thread-source.ts`、`entrypoints/mcp/client-history.ts` 与 adapter 装配共同拥有 active/archived task 的 `list_client_threads` / `read_client_thread` 路径；`application/chat/agent-continuation.ts` 只保留非 Codex Chat 的同 Session `ClientHistoryRequest@1` continuation，通用 Core `AgentHandler` 不解析 ClientHistory schema。
- `local/src/capabilities/scheduled-task/model.ts`、`time.ts`、`store.ts` 与 `store/`：Schedule/ScheduledRun、one-shot/cron/timezone 与 durable admission 的事实源；`store.ts` 保留稳定 facade、Schedule definition/revision 事务及其到通用 callback store 的 parent lifecycle 协调，`store/run.ts` 拥有 ScheduledRun ledger、overlap query 与 Schedule recovery，`store/codec.ts` 拥有 durable row/snapshot codec 与输入归一化。
- `local/src/application/steward/` 与 `local/src/modules/steward/`：Steward Run/series/cycle control/query、module manifest、autonomous `AgentTurnResult@1`、Worker `AgentStepResult@1` / checkpoint、manual `RunDecision@1`、Codex Orchestrator `RunDecision@2` / bounded `OrchestratorState@1`、provider-neutral `RunResultDestination@2`、纯状态机、mandate/workflow admission 与 callback policy 的事实源；`agent_runs`、`agent_run_cycles` 与 `AgentRunContext@1` 是该领域保留的持久格式。
- `local/src/application/work-request/{control,runtime}.ts`：target Local 固定 policy、显式 owner decision、accepted→既有 Steward Run→Server receipt/result 的幂等编排，以及唯一 loop 中的 ephemeral route lease/restart recovery；未接受 request 不创建 Event 或 Run。
- `local/src/modules/external-resource/trigger-binding.ts` 与 `local/src/application/external-resource/{trigger-binding,trigger-guard}.ts`：Schedule/Subscription 可选 ExternalRef trigger binding 的 strict codec、CLI application seam，以及触发时对 Server Integration authority 和 Connector exact revision read 的复核；只返回 matched/rejected，不创建 Run、Event、外写或授权。
- `local/src/infrastructure/sqlite/agent-run-store.ts`：`agent_runs`/`agent_run_cycles` lifecycle、CAS、run/cycle-scoped Session binding、Caller decision audit/idempotency、close/cancel 与 transactional continuation persistence；读取历史 `VikunjaTaskResultDestination@1` 时通过 Vikunja integration 内存归一化为 V2，不回写或执行 schema migration。
- `local/src/application/callback/` 与 `local/src/infrastructure/callback/`：通用 proactive callback、exact grant、observation stdin 和 host/Node command receipt；外部业务 dispatcher 只通过这条边界连接 Continuous Subscription 与普通 Run。
- `local/src/infrastructure/workspace/revision.ts`：external Git workspace canonicalization 与 generic `workspace-revision-v1` 计算；业务 workflow 不得在此加入自己的 sidecar/exclusion 语义。
- `local/resources/workflows/`：versioned Agent workflow 资源；`review@1` 定义细粒度审查，`mr-readiness@1` 定义严格的 MR first-pass result，`forum@1` 定义临时协作；它们都不拥有 Runtime engine、外部业务 lifecycle 或 provider authority。
- `local/src/infrastructure/runtime/config.ts`：Local runtime paths 与 config schema 的事实源。
- `local/src/infrastructure/sqlite/schema/`：Local SQLite v63 的完整 DDL、组合 schema version、兼容 migration 与 projection trigger 的唯一事实边界；`v62-migration.ts` 把 v62 Run 升级为 series/cycle 结构，创建 `agent_run_cycles` 并增加 Session cycle binding。schema upgrade guard 禁止 active Runtime 上原地升库。外层 `schema.ts` 与 `runtime-schema.ts` 是薄入口，runtime mappers 持有 row mapping。
- `local/src/infrastructure/sqlite/transaction.ts`：普通 SQLite store 的 synchronous `BEGIN IMMEDIATE` / commit / rollback 模板；schema creation/migration 因为拥有 introspection、PRAGMA 与 rebuild 顺序而保持显式 transaction。
- `local/src/infrastructure/sqlite/runtime-operations-query.ts`：Runtime Workload、Failure 与 recovery precondition 的只读 SQLite facts adapter，不拥有 durable object 或 projection table。
- `local/src/application/notice/` 与 `local/src/infrastructure/sqlite/notice-store.ts`：Notice list/inspect/read/ack/rebuild 的共同 application contract，以及可重建 projection 与 authoritative user state adapter；RuntimeStore 不拥有 Notice query/control。
- `local/src/entrypoints/cli/main.ts` 与同目录 domain adapters：`main.ts` 只拥有公开 CLI facade、顶层路由和进程入口；Agent、Chat、Channel、Device、Runtime operations、setup 与 foreground start 的参数解析和 application 调用分别归对应 adapter，不在总入口重复业务转换。
- `local/src/entrypoints/console/launcher.ts`、同目录 domain API adapters 与 `local/ui/`：`launcher.ts` 只拥有 loopback route dispatch、Vite source runtime 与 HMR lifecycle；Runtime、Events、Agents、Network、Chats、Steward、Schedules、Subscriptions adapters 与八个 Console nav 对齐，Channel adapter 只暴露 bounded loopback API；它们共用 `http.ts` 的 bounded request/JSON helpers。`local/ui/src/api/schema.ts` 是稳定聚合入口，`local/ui/src/api/schema/` 按 Console 领域拥有 response validation 与 response-derived TypeScript types，`types/` 只保留 schema alias 或 UI-only composition。Review 没有 Console、loopback API、Event codec 或 filter；`scripts/rs start` 不从 `local/ui/dist/` 提供产品 UI。
- `server/src/adapter/persistence/mysql/migrations.ts`：Server MySQL schema migration 的事实源。
- `server/src/adapter/persistence/mysql/repository/support.ts`：Server repository support 的稳定薄聚合入口；`transaction.ts`、`human-support.ts`、`trust-support.ts`、`device-support.ts`、`agent-support.ts` 与 `room-support.ts` 分别拥有共享事务模板和对应 domain row/SQL/mapper，聚合入口不得重新承载 domain 实现。
- `server/src/modules/connector/`、`server/src/api/connector.ts` 与 `server/src/adapter/persistence/{memory,mysql}/connector-repository.ts`：Server-owned Integration binding、revision CAS 与 owner-scoped HTTP surface 的事实源；Connector provider facts、Local Run lifecycle 和 provider mutation 不复制进该对象。
- `server/migrations/0011_project_connector_runtime.sql`：`integration_bindings` 仍是当前 Connector binding 物理 schema；同 migration 创建的 `project_bindings` 与 `external_effects` 是 unreleased 历史 tombstone，应用无 reader/writer/API，保留它们只是避免未授权数据删除。
- `server/src/modules/work-request/`、`server/src/api/work-request.ts` 与 `server/src/adapter/persistence/{memory,mysql}/work-request-repository.ts`：Server-owned Agent work request、pending gate、exact in-memory route lease、requester/target visibility、decision/Run/result CAS 与 idempotency 的事实源；不拥有 Local Run 或离线补推队列。
- `server/migrations/0012_agent_work_requests.sql`：`agent_work_requests` 的共享 lifecycle、requester idempotency、target route/status indexes 与 bounded JSON snapshot 的物理 schema。
- 根 `package.json`：Protocol/Local/Server npm workspace 与全仓 build/test/verify 的事实源；嵌套的 `local/ui/` 由自己的 manifest/lockfile 管理，root `postinstall` 负责 clean install，避免把父 package 与子目录声明成重叠 workspace。

## Generated Artifacts

- `packages/protocol/dist/` ← `packages/protocol/src/` 与 `packages/protocol/test/`，由 TypeScript build 生成，不跟踪、不手工修改。
- `local/dist/` ← `local/src/`、`local/test/` 与 `local/resources/`，由 TypeScript build 和 resource copy step 生成，不跟踪、不手工修改。
- `local/ui/dist/` ← `local/ui/src/`，由 Vite build 生成，不跟踪、不手工修改；它只用于 production-build verification 或显式 frozen artifact，不是 `scripts/rs start` 的产品运行输入。
- `server/dist/` ← `server/src/` 与 `server/test/`，由 TypeScript build 生成，不跟踪、不手工修改。
- `dev/secrets/` ← `dev/init-secrets.mjs`，是 ignored 的本地开发 secret state，不是 repo source，不得提交。
- `tmp/node-test-report.json` ← `node-test.config.mjs` 与 node-test-kit，属于本地验证报告，不是架构事实源。
- `package-lock.json` 与各 package lockfile ← npm manifest resolution；通过 npm 维护，不手工声明依赖事实。

## Documentation Layers

- `docs/architecture/`：当前架构、ownership、ADR、稳定不变量和 change guidance。
- `docs/runbook/`：安装、运行、控制与故障处理步骤。
- `README.md`：人类项目入口和项目状态摘要，不复制完整 source map。

仓库当前没有独立 `doc/` API 生成输入层或 `knowledge/` 长期领域知识层；不要为了满足模板预建空目录。

## Change Guidance

- 新增、删除或重命名 workspace、主要 source root、owner、共享 contract、generator 或主要验证入口时，同一次变更必须更新本页。
- 改 core/Capability/Plugin 信任边界时，同时检查 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)、[Local Runtime](./local-runtime.md) 与自动化隔离证据。
- 改 Server/Local ownership 或跨设备事实源时，同时检查 [Source of truth](./source-of-truth.md) 和对应 ADR。
- `AGENTS.md` 只保留本页的靠前指针与会直接改变 agent 行为的硬规则，不复制本页正文。
